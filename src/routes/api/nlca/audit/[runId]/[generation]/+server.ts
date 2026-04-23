import { json, error, type RequestHandler } from '@sveltejs/kit';
import { loadAndAuditFrame } from '$lib/server/promptAuditApi.js';

export const GET: RequestHandler = async ({ params }) => {
	const runId = params.runId;
	const generation = Number(params.generation);
	if (!runId) throw error(400, 'runId required');
	if (!Number.isFinite(generation) || generation < 1)
		throw error(400, 'generation must be a positive integer');
	const report = loadAndAuditFrame(runId, generation);
	if (!report) throw error(404, `No log for run "${runId}" generation ${generation}`);
	return json(report);
};
