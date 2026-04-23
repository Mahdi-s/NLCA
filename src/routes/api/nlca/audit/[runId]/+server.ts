import { json, error, type RequestHandler } from '@sveltejs/kit';
import { loadAndAuditRun } from '$lib/server/promptAuditApi.js';

export const GET: RequestHandler = async ({ params }) => {
	const runId = params.runId;
	if (!runId) throw error(400, 'runId required');
	const report = loadAndAuditRun(runId);
	if (!report) throw error(404, `No prompt logs found for run "${runId}"`);
	return json(report);
};

export const HEAD: RequestHandler = async ({ params }) => {
	const runId = params.runId;
	if (!runId) return new Response(null, { status: 400 });
	const report = loadAndAuditRun(runId);
	return new Response(null, { status: report ? 200 : 404 });
};
