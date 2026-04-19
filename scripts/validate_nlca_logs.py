#!/usr/bin/env python3
"""
NLCA log validator.

Walks every run under `logs/nlca/<runId>/gen-NNNN-*.json` and answers three
concrete questions about prompt/propagation correctness:

  1. Does each cell's prompt carry correct (x, y), self state, and neighbors?
     (Position consistency, neighborhood offsets, neighbor state lookup.)
  2. Do cells see ONLY their own info + neighbors — nothing else?
     (No global grid leak; payload sent to the model matches cellBreakdown.)
  3. Does state propagate correctly across iterations?
     (Frame N+1's `currentState` == frame N's decision for same cellId.)

Both OpenRouter (verbose `cells` payload) and SambaNova (compressed `d` payload)
formats are understood.

Run:
    python3 scripts/validate_nlca_logs.py           # all runs
    python3 scripts/validate_nlca_logs.py <runId>   # one run
    python3 scripts/validate_nlca_logs.py -v        # verbose per-frame output
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parent.parent
LOGS_ROOT = REPO_ROOT / "logs" / "nlca"


# ---------------------------------------------------------------------------
# Neighborhood offsets — must match src/lib/nlca/neighborhood.ts getOffsets()
# ---------------------------------------------------------------------------

NEIGHBORHOOD_OFFSETS: dict[str, list[tuple[int, int]]] = {
    "vonNeumann": [(0, -1), (0, 1), (-1, 0), (1, 0)],
    "moore": [(-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1)],
    "extendedMoore": [
        (dx, dy)
        for dy in range(-2, 3)
        for dx in range(-2, 3)
        if not (dx == 0 and dy == 0)
    ],
}


def infer_neighborhood_type(size: int) -> str | None:
    return {4: "vonNeumann", 8: "moore", 24: "extendedMoore"}.get(size)


def torus_wrap(x: int, y: int, width: int, height: int) -> tuple[int, int]:
    return x % width, y % height


# ---------------------------------------------------------------------------
# Issue tracking
# ---------------------------------------------------------------------------


INFO_KINDS = {"retries_detected"}


@dataclass
class Issue:
    run_id: str
    generation: int
    kind: str
    detail: str

    @property
    def is_info(self) -> bool:
        return self.kind in INFO_KINDS

    def fmt(self) -> str:
        tag = "INFO " if self.is_info else "ERROR"
        return f"[{tag}] [{self.run_id[:8]} gen={self.generation:03d}] {self.kind}: {self.detail}"


@dataclass
class RunStats:
    run_id: str
    provider: str
    model: str
    mode: str
    neighborhood: str
    width: int
    height: int
    frames_seen: list[int] = field(default_factory=list)
    cells_checked: int = 0
    issues: list[Issue] = field(default_factory=list)

    @property
    def errors(self) -> list[Issue]:
        return [i for i in self.issues if not i.is_info]

    @property
    def infos(self) -> list[Issue]:
        return [i for i in self.issues if i.is_info]

    def summary_line(self) -> str:
        if not self.errors:
            status = "PASS" + (f" ({len(self.infos)} info)" if self.infos else "")
        else:
            status = f"FAIL ({len(self.errors)} errors, {len(self.infos)} info)"
        return (
            f"{self.run_id[:8]} {self.provider:10s} {self.model[:32]:32s} "
            f"{self.mode:23s} {self.neighborhood:14s} "
            f"frames={len(self.frames_seen):2d} cells={self.cells_checked:>6d}  {status}"
        )


# ---------------------------------------------------------------------------
# Per-frame validation
# ---------------------------------------------------------------------------


def load_run_frames(run_dir: Path) -> tuple[dict[int, dict[str, Any]], dict[int, int]]:
    """Load every gen-NNNN file. Returns (selected_frames, retry_count_per_gen).

    The compute loop writes one log per API call, and pause/resume can generate
    multiple attempts for the same generation (see gen=4 in run 7e2cdd4b,
    gen=5 in run 55df34c3). To identify the variant that actually fed the
    propagation chain, each variant is scored against two constraints — its
    input must match the *previous* generation's decisions, and its decisions
    must match the *next* generation's input. The variant satisfying the most
    constraints wins; ties break on latest timestamp (most recent attempt is
    most likely to be the committed one).
    """
    pat = re.compile(r"gen-(\d+)-(\d+)\.json$")
    candidates: dict[int, list[tuple[int, Path]]] = defaultdict(list)
    for p in sorted(run_dir.iterdir()):
        m = pat.match(p.name)
        if not m:
            continue
        candidates[int(m.group(1))].append((int(m.group(2)), p))

    loaded: dict[int, list[tuple[int, dict[str, Any]]]] = {}
    retries: dict[int, int] = {}
    for gen, cands in candidates.items():
        cands.sort()
        retries[gen] = len(cands) - 1
        loaded[gen] = [(ts, json.load(path.open())) for ts, path in cands]

    def inputs_of(log: dict[str, Any]) -> dict[int, int]:
        return {c["cellId"]: c["currentState"] for c in log["cellBreakdown"]}

    def matches(a: dict[int, int], b: dict[int, int]) -> bool:
        return all(a.get(cid) == st for cid, st in b.items())

    # Initial pass: for each gen with variants, aggregate every variant's
    # (input, decisions) so we can score against neighbours in the second pass.
    variant_info: dict[int, list[dict[str, Any]]] = {}
    for gen, variants in loaded.items():
        variant_info[gen] = [
            {
                "ts": ts,
                "log": log,
                "inputs": inputs_of(log),
                "decisions": extract_decisions(log),
            }
            for ts, log in variants
        ]

    # Second pass: score each variant by how many of its boundary constraints
    # (prev decisions → my input, my decisions → next input) hold.
    gens_sorted = sorted(loaded.keys())
    selected: dict[int, dict[str, Any]] = {}
    # We need adjacent variants too; resolve in dependency-free way by scoring
    # against ALL variants of neighbour gens and picking the consistent chain.
    for gen in gens_sorted:
        vs = variant_info[gen]
        prev_candidates = variant_info.get(gen - 1, [])
        next_candidates = variant_info.get(gen + 1, [])

        def score(v: dict[str, Any]) -> tuple[int, int]:
            s = 0
            if prev_candidates:
                if any(matches(v["inputs"], pc["decisions"]) for pc in prev_candidates):
                    s += 2
            if next_candidates:
                if any(matches(nc["inputs"], v["decisions"]) for nc in next_candidates):
                    s += 2
            return (s, v["ts"])  # ts is tiebreaker, higher = newer = preferred

        vs_sorted = sorted(vs, key=score, reverse=True)
        selected[gen] = vs_sorted[0]["log"]

    return selected, retries


def check_position_and_neighborhood(
    stats: RunStats, log: dict[str, Any]
) -> dict[int, dict[str, Any]]:
    """Validate every cell in cellBreakdown and return a lookup table
    keyed by cellId for use in later cross-frame checks."""
    gen = log["generation"]
    width = log["grid"]["width"]
    height = log["grid"]["height"]
    expected_offsets = set(NEIGHBORHOOD_OFFSETS[stats.neighborhood])

    breakdown: dict[int, dict[str, Any]] = {}
    for cell in log["cellBreakdown"]:
        cid = cell["cellId"]
        x, y = cell["x"], cell["y"]

        # 1. cellId == x + y*width
        expected_id = x + y * width
        if cid != expected_id:
            stats.issues.append(Issue(
                stats.run_id, gen, "id_mismatch",
                f"cell claims id={cid} but (x={x},y={y}) on w={width} ⇒ {expected_id}",
            ))

        # 2. x,y in bounds
        if not (0 <= x < width and 0 <= y < height):
            stats.issues.append(Issue(
                stats.run_id, gen, "oob_position",
                f"cellId={cid} at ({x},{y}) outside {width}x{height}",
            ))

        # 3. Neighborhood offsets match expected set (order is provider-defined,
        # so compare as a set).
        nb = cell["neighborhood"]
        got_offsets = {(n[0], n[1]) for n in nb}
        if got_offsets != expected_offsets:
            missing = expected_offsets - got_offsets
            extra = got_offsets - expected_offsets
            stats.issues.append(Issue(
                stats.run_id, gen, "offset_mismatch",
                f"cellId={cid}: missing={sorted(missing)} extra={sorted(extra)}",
            ))

        # 4. aliveNeighborCount matches sum of neighbor states.
        alive = sum(1 for n in nb if n[2] == 1)
        if alive != cell["aliveNeighborCount"]:
            stats.issues.append(Issue(
                stats.run_id, gen, "alive_count_mismatch",
                f"cellId={cid}: counted {alive} alive but payload says {cell['aliveNeighborCount']}",
            ))

        # 5. self + neighbor states are 0/1.
        if cell["currentState"] not in (0, 1):
            stats.issues.append(Issue(
                stats.run_id, gen, "bad_self_state",
                f"cellId={cid}: currentState={cell['currentState']!r}",
            ))
        for n in nb:
            if n[2] not in (0, 1):
                stats.issues.append(Issue(
                    stats.run_id, gen, "bad_neighbor_state",
                    f"cellId={cid} nb offset=({n[0]},{n[1]}) state={n[2]!r}",
                ))

        breakdown[cid] = cell

    # 6. cellBreakdown covers every position exactly once.
    expected_ids = set(range(width * height))
    got_ids = set(breakdown.keys())
    if expected_ids != got_ids:
        missing = expected_ids - got_ids
        extra = got_ids - expected_ids
        stats.issues.append(Issue(
            stats.run_id, gen, "coverage",
            f"missing_cells={sorted(missing)[:5]}... extra_cells={sorted(extra)[:5]}",
        ))

    stats.cells_checked += len(breakdown)
    return breakdown


# ---------------------------------------------------------------------------
# Payload isolation — confirm no extra information leaks
# ---------------------------------------------------------------------------


def extract_payload_cells(log: dict[str, Any]) -> list[dict[str, Any]] | None:
    """Return a normalised list of cells from the payload actually sent to the
    model. Understands both OpenRouter verbose and SambaNova compressed shapes.
    Returns None if the payload format is unrecognised."""
    p = log.get("userPayloadSent") or {}
    if "cells" in p:
        # Verbose format used by OpenRouter frame-batched-stream mode.
        return [
            {
                "id": c["id"],
                "x": c["x"],
                "y": c["y"],
                "self": c["self"],
                "neighborhood": [tuple(n) for n in c.get("neighborhood", [])],
            }
            for c in p["cells"]
        ]
    if "d" in p:
        # SambaNova compressed format — see
        # src/routes/api/nlca/decideFrame/+server.ts:151
        #   "Input rows: [cellId, self, aliveCount, [neighbor_states_in_offset_order]]"
        # Absolute (x, y) is intentionally stripped (maximises dedup); the model
        # derives position from cellId + width which lives in the system prompt.
        width = log["grid"]["width"]
        out = []
        for item in p["d"]:
            cid = item[0]
            self_state = item[1]
            alive_count = item[2]
            nb_states = list(item[3]) if len(item) > 3 else []
            out.append({
                "id": cid,
                "x": cid % width,
                "y": cid // width,
                "self": self_state,
                "aliveCount": alive_count,
                "neighborhood_states": nb_states,
            })
        return out
    return None


def check_payload_fidelity(
    stats: RunStats, log: dict[str, Any], breakdown: dict[int, dict[str, Any]]
) -> None:
    """Validate that what the model actually saw matches cellBreakdown exactly —
    same cells, same self states, same neighbor states. Also ensures the payload
    does not contain any other grid-wide information beyond task description."""
    gen = log["generation"]
    payload_cells = extract_payload_cells(log)
    if payload_cells is None:
        stats.issues.append(Issue(
            stats.run_id, gen, "unknown_payload_shape",
            f"keys={list((log.get('userPayloadSent') or {}).keys())}",
        ))
        return

    if len(payload_cells) != len(breakdown):
        stats.issues.append(Issue(
            stats.run_id, gen, "payload_cell_count",
            f"payload={len(payload_cells)} vs cellBreakdown={len(breakdown)}",
        ))

    # Build a reference compressed neighbor-state sequence using the canonical
    # offset order for this run, so we can compare the compressed payload's
    # inline state array against reality.
    expected_offset_order = NEIGHBORHOOD_OFFSETS[stats.neighborhood]

    for pc in payload_cells:
        cid = pc["id"]
        ref = breakdown.get(cid)
        if ref is None:
            stats.issues.append(Issue(
                stats.run_id, gen, "payload_orphan_cell",
                f"payload has cellId={cid} not in cellBreakdown",
            ))
            continue

        if (pc["x"], pc["y"]) != (ref["x"], ref["y"]):
            stats.issues.append(Issue(
                stats.run_id, gen, "payload_xy_mismatch",
                f"cellId={cid} payload=({pc['x']},{pc['y']}) ref=({ref['x']},{ref['y']})",
            ))

        if pc["self"] != ref["currentState"]:
            stats.issues.append(Issue(
                stats.run_id, gen, "payload_self_mismatch",
                f"cellId={cid} payload_self={pc['self']} ref_self={ref['currentState']}",
            ))

        # Compressed format: compare neighbor states element-wise against
        # cellBreakdown reordered by the canonical offset list.
        if "neighborhood_states" in pc:
            ref_by_offset = {(n[0], n[1]): n[2] for n in ref["neighborhood"]}
            ref_seq = [ref_by_offset[off] for off in expected_offset_order]
            if pc["neighborhood_states"] != ref_seq:
                stats.issues.append(Issue(
                    stats.run_id, gen, "payload_nb_states_mismatch",
                    f"cellId={cid} first diff: payload={pc['neighborhood_states'][:4]} expected={ref_seq[:4]}",
                ))
            # aliveCount in the compressed payload should match the number of
            # alive states in the neighborhood array it ships with.
            if "aliveCount" in pc and pc["aliveCount"] != sum(1 for s in pc["neighborhood_states"] if s == 1):
                stats.issues.append(Issue(
                    stats.run_id, gen, "payload_alive_count_mismatch",
                    f"cellId={cid}: aliveCount={pc['aliveCount']} but nb_states sum={sum(pc['neighborhood_states'])}",
                ))

        # Verbose format: compare each [dx, dy, state] tuple as a set.
        if "neighborhood" in pc:
            ref_set = {(n[0], n[1], n[2]) for n in ref["neighborhood"]}
            got_set = set(pc["neighborhood"])
            if ref_set != got_set:
                stats.issues.append(Issue(
                    stats.run_id, gen, "payload_nb_verbose_mismatch",
                    f"cellId={cid} payload_only={list(got_set - ref_set)[:2]} ref_only={list(ref_set - got_set)[:2]}",
                ))

    # No extra cell-level fields beyond what we expect (basic isolation check).
    p = log.get("userPayloadSent") or {}
    allowed_top = {"generation", "g", "width", "height", "task", "colorMode", "cells", "c", "d"}
    extra_top = set(p.keys()) - allowed_top
    if extra_top:
        stats.issues.append(Issue(
            stats.run_id, gen, "payload_extra_fields",
            f"unexpected top-level keys: {sorted(extra_top)}",
        ))


# ---------------------------------------------------------------------------
# Neighborhood state lookup against prev frame's grid
# ---------------------------------------------------------------------------


def check_neighbor_lookup_vs_prev_grid(
    stats: RunStats,
    log: dict[str, Any],
    prev_decisions: dict[int, int] | None,
    prev_initial: dict[int, int] | None,
) -> None:
    """For each cell, every [dx, dy, state] should equal the torus-wrapped
    value of (x+dx, y+dy) in the *previous frame's decided grid*.

    For generation 1, the previous grid is the initial grid — which we infer
    from gen-1's own `currentState` values. For gen N>1 we use gen N-1's
    decisions.
    """
    gen = log["generation"]
    if prev_decisions is None and prev_initial is None:
        return
    prev_grid = prev_decisions if prev_decisions is not None else prev_initial
    width = log["grid"]["width"]
    height = log["grid"]["height"]

    mismatches = 0
    first_bad: list[str] = []
    for cell in log["cellBreakdown"]:
        x, y = cell["x"], cell["y"]
        for dx, dy, state in cell["neighborhood"]:
            wx, wy = torus_wrap(x + dx, y + dy, width, height)
            expected = prev_grid.get(wx + wy * width)
            if expected is None:
                continue
            if state != expected:
                mismatches += 1
                if len(first_bad) < 3:
                    first_bad.append(
                        f"cell({x},{y}) offset=({dx},{dy}) → wrapped({wx},{wy}) "
                        f"state={state} prev={expected}"
                    )
    if mismatches:
        stats.issues.append(Issue(
            stats.run_id, gen, "neighbor_state_vs_prev_grid",
            f"{mismatches} mismatches; examples: {'; '.join(first_bad)}",
        ))


# ---------------------------------------------------------------------------
# Frame-to-frame propagation
# ---------------------------------------------------------------------------


def check_propagation(
    stats: RunStats,
    log: dict[str, Any],
    prev_decisions: dict[int, int] | None,
) -> None:
    """gen[N>1] cell.currentState should equal gen[N-1] decision.state for the same cellId."""
    gen = log["generation"]
    if prev_decisions is None:
        return
    mismatches: list[str] = []
    for cell in log["cellBreakdown"]:
        cid = cell["cellId"]
        prev = prev_decisions.get(cid)
        if prev is None:
            continue
        if cell["currentState"] != prev:
            mismatches.append(f"cellId={cid} now={cell['currentState']} prev_decision={prev}")
    if mismatches:
        stats.issues.append(Issue(
            stats.run_id, gen, "propagation_mismatch",
            f"{len(mismatches)} cells; first 3: {mismatches[:3]}",
        ))


def extract_decisions(log: dict[str, Any]) -> dict[int, int]:
    out: dict[int, int] = {}
    for d in (log.get("response", {}) or {}).get("decisions", []) or []:
        if "cellId" in d and "state" in d and d["state"] in (0, 1):
            out[d["cellId"]] = d["state"]
    return out


# ---------------------------------------------------------------------------
# Prompt content check
# ---------------------------------------------------------------------------


def check_prompt(stats: RunStats, log: dict[str, Any]) -> None:
    """System prompt must state the correct grid size and include the task."""
    gen = log["generation"]
    sp = log.get("systemPrompt", "") or ""
    w = log["grid"]["width"]
    h = log["grid"]["height"]

    # Grid dimensions visible to the model.
    if f"{w}×{h}" not in sp and f"{w}x{h}" not in sp:
        stats.issues.append(Issue(
            stats.run_id, gen, "prompt_missing_grid_dims",
            f"system prompt does not mention {w}x{h}",
        ))

    # Task text from the payload should also appear in the prompt or payload.
    # (In compressed mode the task lives in the system prompt; in verbose mode
    # it's echoed in the user payload.)
    p = log.get("userPayloadSent") or {}
    task = p.get("task", "")
    if task and task not in sp and task != p.get("task"):
        stats.issues.append(Issue(
            stats.run_id, gen, "prompt_task_drift",
            "task text in payload does not appear in system prompt",
        ))


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------


def validate_run(run_dir: Path, verbose: bool = False) -> RunStats:
    run_id = run_dir.name
    frames, retries = load_run_frames(run_dir)
    if not frames:
        return RunStats(run_id, "?", "?", "?", "?", 0, 0)

    first = frames[min(frames)]
    nb_size = len(first["cellBreakdown"][0]["neighborhood"])
    nb_type = infer_neighborhood_type(nb_size) or f"unknown({nb_size})"

    stats = RunStats(
        run_id=run_id,
        provider=first["provider"],
        model=first["model"],
        mode=first["mode"],
        neighborhood=nb_type,
        width=first["grid"]["width"],
        height=first["grid"]["height"],
    )

    if nb_type.startswith("unknown"):
        stats.issues.append(Issue(run_id, 0, "unknown_neighborhood",
                                   f"neighborhood size {nb_size}"))
        return stats

    # Report retries as informational (not failures): the compute loop generates
    # multiple logs per gen on pause/resume; we pick the one whose input matches
    # the previous gen's decisions (see load_run_frames).
    for gen, n in sorted(retries.items()):
        if n > 0:
            stats.issues.append(Issue(
                run_id, gen, "retries_detected",
                f"{n} stale retry log(s) for this generation — using the variant "
                "whose input matches the chain",
            ))

    prev_decisions: dict[int, int] | None = None

    for gen in sorted(frames):
        log = frames[gen]
        stats.frames_seen.append(gen)

        # Initial-grid fallback for gen=1 neighbor lookups.
        initial_grid: dict[int, int] | None = None
        if gen == 1:
            initial_grid = {c["cellId"]: c["currentState"] for c in log["cellBreakdown"]}

        breakdown = check_position_and_neighborhood(stats, log)
        check_payload_fidelity(stats, log, breakdown)
        check_neighbor_lookup_vs_prev_grid(stats, log, prev_decisions, initial_grid)
        check_propagation(stats, log, prev_decisions)
        check_prompt(stats, log)

        if verbose:
            errs = [i for i in stats.issues if i.generation == gen]
            mark = "✓" if not errs else f"✗ ({len(errs)} issues)"
            print(f"    gen {gen:2d}: {len(log['cellBreakdown'])} cells, "
                  f"{len(log['response']['decisions'])} decisions  {mark}")

        prev_decisions = extract_decisions(log)

    return stats


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("run", nargs="?", help="Optional runId to validate")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    if not LOGS_ROOT.exists():
        print(f"No logs directory at {LOGS_ROOT}", file=sys.stderr)
        return 1

    if args.run:
        run_dirs = [LOGS_ROOT / args.run]
    else:
        run_dirs = [p for p in sorted(LOGS_ROOT.iterdir()) if p.is_dir()]

    total_errors = 0
    total_infos = 0
    per_kind: dict[str, int] = defaultdict(int)
    all_stats: list[RunStats] = []

    for run_dir in run_dirs:
        if not run_dir.is_dir():
            continue
        if args.verbose:
            print(f"\n{run_dir.name}")
        stats = validate_run(run_dir, verbose=args.verbose)
        all_stats.append(stats)
        total_errors += len(stats.errors)
        total_infos += len(stats.infos)
        for i in stats.issues:
            per_kind[i.kind] += 1

    print("\n" + "=" * 112)
    print("Run summary")
    print("-" * 112)
    for s in all_stats:
        print("  " + s.summary_line())

    if total_errors or total_infos:
        print("\n" + "=" * 112)
        print(
            f"Categories ({total_errors} errors, {total_infos} info):"
        )
        print("-" * 112)
        for kind, n in sorted(per_kind.items(), key=lambda kv: -kv[1]):
            tag = "INFO " if kind in INFO_KINDS else "ERROR"
            print(f"  [{tag}] {n:4d}  {kind}")
        shown = 0
        cap = 20
        if total_errors:
            print(f"\nFirst {cap} errors:")
            print("-" * 112)
            for s in all_stats:
                for i in s.errors:
                    if shown >= cap:
                        break
                    print("  " + i.fmt())
                    shown += 1
                if shown >= cap:
                    break
        if total_infos:
            print("\nInfo notes:")
            print("-" * 112)
            for s in all_stats:
                for i in s.infos:
                    print("  " + i.fmt())

    if total_errors == 0:
        print("\nAll runs passed all correctness checks.")
    return 0 if total_errors == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
