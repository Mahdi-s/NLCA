import { describe, expect, test } from 'vitest';
import {
	buildCellSystemPrompt,
	buildOutputContractText,
	normalizeHexColor,
	packCellColorHexToU32,
	parseCellResponse
} from './prompt.js';

describe('normalizeHexColor', () => {
	test('accepts #RRGGBB and normalizes to uppercase', () => {
		expect(normalizeHexColor('#a1b2c3')).toBe('#A1B2C3');
		expect(normalizeHexColor('#A1B2C3')).toBe('#A1B2C3');
	});

	test('rejects invalid formats', () => {
		expect(normalizeHexColor('A1B2C3')).toBeNull();
		expect(normalizeHexColor('#ABC')).toBeNull();
		expect(normalizeHexColor('#A1B2C3DD')).toBeNull();
		expect(normalizeHexColor('#A1B2CG')).toBeNull();
	});
});

describe('buildCellSystemPrompt output contract', () => {
	test('state-only mode does not require color', () => {
		const prompt = buildCellSystemPrompt(0, 1, 2, 10, 10, {
			taskDescription: 'Test',
			useAdvancedMode: false,
			cellColorHexEnabled: false
		});
		expect(prompt).toContain('== OUTPUT FORMAT ==');
		expect(prompt).toContain('{"state":0}');
		expect(prompt).not.toContain('"color"');
	});

	test('color mode requires deterministic #RRGGBB', () => {
		const prompt = buildCellSystemPrompt(0, 1, 2, 10, 10, {
			taskDescription: 'Test',
			useAdvancedMode: false,
			cellColorHexEnabled: true
		});
		expect(prompt).toContain('"color":"#RRGGBB"');
		expect(prompt).toContain('uppercase hex digits');
	});
});

describe('buildOutputContractText', () => {
	test('includes color contract when enabled', () => {
		const contract = buildOutputContractText({
			taskDescription: 'Test',
			useAdvancedMode: false,
			cellColorHexEnabled: true
		});
		expect(contract).toContain('"color":"#RRGGBB"');
		expect(contract).toContain('uppercase');
	});
});

describe('scene-style tasks', () => {
	test('tree + mountains scene task works with color contract', () => {
		const task = 'Draw a landscape with mountains and a tree. If you are part of the scene, output {"state":1,"color":"#RRGGBB"}.';
		const prompt = buildCellSystemPrompt(0, 1, 2, 24, 24, {
			taskDescription: task,
			useAdvancedMode: false,
			cellColorHexEnabled: true
		});
		expect(prompt).toContain('mountains');
		expect(prompt).toContain('"color":"#RRGGBB"');
	});
});

describe('parseCellResponse', () => {
	test('parses state and valid color', () => {
		const res = parseCellResponse(`{"state":1,"color":"#a1b2c3"}`);
		expect(res).not.toBeNull();
		expect(res?.state).toBe(1);
		expect(res?.colorHex).toBe('#A1B2C3');
		expect(res?.colorStatus).toBe('valid');
	});

	test('flags invalid color without crashing', () => {
		const res = parseCellResponse(`{"state":0,"color":"#GGGGGG"}`);
		expect(res).not.toBeNull();
		expect(res?.state).toBe(0);
		expect(res?.colorHex).toBeUndefined();
		expect(res?.colorStatus).toBe('invalid');
	});

	test('marks missing color when not provided', () => {
		const res = parseCellResponse(`{"state":1}`);
		expect(res).not.toBeNull();
		expect(res?.state).toBe(1);
		expect(res?.colorStatus).toBe('missing');
	});
});

describe('packCellColorHexToU32', () => {
	test('packs valid colors into u32 (status in high bits)', () => {
		expect(packCellColorHexToU32('#000000', 'valid')).toBe(0x01000000);
		expect(packCellColorHexToU32('#FFFFFF', 'valid')).toBe(0x01ffffff);
	});

	test('normalizes lowercase hex when packing', () => {
		expect(packCellColorHexToU32('#a1b2c3', 'valid')).toBe(0x01a1b2c3);
	});

	test('encodes missing/invalid status without requiring a color', () => {
		expect(packCellColorHexToU32(undefined, 'missing')).toBe(0x00000000);
		expect(packCellColorHexToU32(null, 'invalid')).toBe(0x02000000);
	});

	test('defensively treats invalid hex as invalid even if marked valid', () => {
		expect(packCellColorHexToU32('#GGGGGG', 'valid')).toBe(0x02000000);
	});
});

