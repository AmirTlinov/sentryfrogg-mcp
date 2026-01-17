#!/usr/bin/env node
"use strict";
// @ts-nocheck
Object.defineProperty(exports, "__esModule", { value: true });
const ToolError = require('../errors/ToolError');
const { unknownActionError } = require('../utils/toolErrors');
const JOB_ACTIONS = [
    'job_status',
    'job_wait',
    'job_logs_tail',
    'tail_job',
    'follow_job',
    'job_cancel',
    'job_forget',
    'job_list',
];
function readPositiveInt(value) {
    if (value === undefined || value === null || value === '') {
        return null;
    }
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue) || numberValue <= 0) {
        return null;
    }
    return Math.floor(numberValue);
}
function nowIso() {
    return new Date().toISOString();
}
function publicJobView(job) {
    if (!job || typeof job !== 'object') {
        return null;
    }
    const expires = job.expires_at_ms ? new Date(job.expires_at_ms).toISOString() : null;
    return {
        job_id: job.job_id,
        kind: job.kind,
        status: job.status,
        trace_id: job.trace_id,
        parent_span_id: job.parent_span_id,
        created_at: job.created_at,
        started_at: job.started_at,
        updated_at: job.updated_at,
        ended_at: job.ended_at,
        expires_at: expires,
        progress: job.progress ?? null,
        artifacts: job.artifacts ?? null,
        provider: job.provider ?? null,
        error: job.error ?? null,
    };
}
class JobManager {
    constructor(logger, validation, jobService, { sshManager } = {}) {
        this.logger = logger.child('job');
        this.validation = validation;
        this.jobService = jobService;
        this.sshManager = sshManager || null;
    }
    ensureJobId(value) {
        if (this.validation?.ensureString) {
            return this.validation.ensureString(value, 'job_id');
        }
        if (typeof value !== 'string' || value.trim().length === 0) {
            throw ToolError.invalidParams({ field: 'job_id', message: 'job_id must be a non-empty string' });
        }
        return value.trim();
    }
    async handleAction(args = {}) {
        const action = args.action;
        switch (action) {
            case 'job_status':
                return this.jobStatus(args);
            case 'job_wait':
                return this.jobWait(args);
            case 'job_logs_tail':
                return this.jobLogsTail(args);
            case 'tail_job':
                return this.tailJob(args);
            case 'follow_job':
                return this.followJob(args);
            case 'job_cancel':
                return this.jobCancel(args);
            case 'job_forget':
                return this.jobForget(args);
            case 'job_list':
                return this.jobList(args);
            default:
                throw unknownActionError({ tool: 'job', action, knownActions: JOB_ACTIONS });
        }
    }
    async jobStatus(args = {}) {
        const jobId = this.ensureJobId(args.job_id);
        const job = this.jobService.get(jobId);
        if (!job) {
            return { success: false, code: 'NOT_FOUND', job_id: jobId };
        }
        const providerTool = job.provider?.tool;
        if (providerTool === 'mcp_ssh_manager') {
            if (!this.sshManager) {
                throw ToolError.internal({ code: 'SSH_MANAGER_UNAVAILABLE', message: 'SSH manager is not available' });
            }
            const status = await this.sshManager.jobStatus({ ...args, job_id: jobId });
            if (status.success) {
                const nextStatus = status.exited
                    ? (status.exit_code === 0 ? 'succeeded' : 'failed')
                    : 'running';
                this.jobService.upsert({
                    job_id: jobId,
                    status: nextStatus,
                    started_at: job.started_at || job.created_at,
                    ended_at: status.exited ? (job.ended_at || nowIso()) : null,
                });
            }
            return { success: true, job: publicJobView(this.jobService.get(jobId)), status };
        }
        return { success: false, code: 'NOT_SUPPORTED', job_id: jobId, kind: job.kind };
    }
    async jobWait(args = {}) {
        const jobId = this.ensureJobId(args.job_id);
        const job = this.jobService.get(jobId);
        if (!job) {
            return { success: false, code: 'NOT_FOUND', job_id: jobId };
        }
        const providerTool = job.provider?.tool;
        if (providerTool === 'mcp_ssh_manager') {
            if (!this.sshManager) {
                throw ToolError.internal({ code: 'SSH_MANAGER_UNAVAILABLE', message: 'SSH manager is not available' });
            }
            const wait = await this.sshManager.jobWait({ ...args, job_id: jobId });
            const status = wait.status;
            if (status?.success && status.exited) {
                const nextStatus = status.exit_code === 0 ? 'succeeded' : 'failed';
                this.jobService.upsert({ job_id: jobId, status: nextStatus, ended_at: job.ended_at || nowIso() });
            }
            return { success: true, job: publicJobView(this.jobService.get(jobId)), wait };
        }
        const budgetMs = readPositiveInt(process.env.SENTRYFROGG_TOOL_CALL_TIMEOUT_MS || process.env.SF_TOOL_CALL_TIMEOUT_MS) ?? 55_000;
        const requested = readPositiveInt(args.timeout_ms) ?? 30_000;
        const timeoutMs = Math.min(requested, budgetMs);
        const pollMs = Math.min(readPositiveInt(args.poll_interval_ms) ?? 1000, 5000);
        const started = Date.now();
        while (Date.now() - started + pollMs <= timeoutMs) {
            const current = this.jobService.get(jobId);
            if (!current) {
                return { success: false, code: 'NOT_FOUND', job_id: jobId };
            }
            if (current.status === 'succeeded' || current.status === 'failed' || current.status === 'canceled') {
                return {
                    success: true,
                    job: publicJobView(current),
                    wait: { completed: true, timed_out: false, waited_ms: Date.now() - started, timeout_ms: timeoutMs, poll_interval_ms: pollMs },
                };
            }
            await new Promise((resolve) => setTimeout(resolve, pollMs));
        }
        return {
            success: true,
            job: publicJobView(this.jobService.get(jobId)),
            wait: { completed: false, timed_out: true, waited_ms: Date.now() - started, timeout_ms: timeoutMs, poll_interval_ms: pollMs },
        };
    }
    async jobLogsTail(args = {}) {
        const jobId = this.ensureJobId(args.job_id);
        const job = this.jobService.get(jobId);
        if (!job) {
            return { success: false, code: 'NOT_FOUND', job_id: jobId };
        }
        const providerTool = job.provider?.tool;
        if (providerTool === 'mcp_ssh_manager') {
            if (!this.sshManager) {
                throw ToolError.internal({ code: 'SSH_MANAGER_UNAVAILABLE', message: 'SSH manager is not available' });
            }
            const logs = await this.sshManager.jobLogsTail({ ...args, job_id: jobId, lines: args.lines });
            return { success: true, job: publicJobView(job), logs };
        }
        return { success: false, code: 'NOT_SUPPORTED', job_id: jobId, kind: job.kind };
    }
    async tailJob(args = {}) {
        const jobId = this.ensureJobId(args.job_id);
        const job = this.jobService.get(jobId);
        if (!job) {
            return { success: false, code: 'NOT_FOUND', job_id: jobId };
        }
        const providerTool = job.provider?.tool;
        if (providerTool === 'mcp_ssh_manager') {
            if (!this.sshManager) {
                throw ToolError.internal({ code: 'SSH_MANAGER_UNAVAILABLE', message: 'SSH manager is not available' });
            }
            const lines = Math.min(readPositiveInt(args.lines) ?? 120, 2000);
            const budgetMs = readPositiveInt(process.env.SENTRYFROGG_TOOL_CALL_TIMEOUT_MS || process.env.SF_TOOL_CALL_TIMEOUT_MS) ?? 55_000;
            const timeoutMs = Math.min(readPositiveInt(args.timeout_ms) ?? 10000, budgetMs);
            const status = await this.sshManager.jobStatus({ ...args, job_id: jobId, timeout_ms: timeoutMs });
            if (status?.success) {
                const nextStatus = status.exited
                    ? (status.exit_code === 0 ? 'succeeded' : 'failed')
                    : 'running';
                this.jobService.upsert({
                    job_id: jobId,
                    status: nextStatus,
                    started_at: job.started_at || job.created_at,
                    ended_at: status.exited ? (job.ended_at || nowIso()) : null,
                });
            }
            const logs = await this.sshManager.jobLogsTail({ ...args, job_id: jobId, lines, timeout_ms: timeoutMs });
            return {
                success: Boolean(status?.success && logs?.success),
                job: publicJobView(this.jobService.get(jobId)),
                status,
                logs,
            };
        }
        return { success: false, code: 'NOT_SUPPORTED', job_id: jobId, kind: job.kind };
    }
    async followJob(args = {}) {
        const jobId = this.ensureJobId(args.job_id);
        const job = this.jobService.get(jobId);
        if (!job) {
            return { success: false, code: 'NOT_FOUND', job_id: jobId };
        }
        const wait = await this.jobWait({
            ...args,
            action: 'job_wait',
            job_id: jobId,
        });
        const logs = await this.jobLogsTail({
            ...args,
            action: 'job_logs_tail',
            job_id: jobId,
            lines: args.lines,
        });
        const current = this.jobService.get(jobId);
        const logsPayload = logs?.logs ?? logs;
        const logsNotSupported = logsPayload && typeof logsPayload === 'object' && logsPayload.code === 'NOT_SUPPORTED';
        const logsOk = logsPayload && typeof logsPayload === 'object' && logsPayload.success === true;
        return {
            success: Boolean(wait?.success && (logsOk || logsNotSupported)),
            job: publicJobView(current || job),
            wait: wait?.wait ?? wait,
            status: wait?.status ?? wait?.wait?.status ?? null,
            logs: logsPayload,
        };
    }
    async jobCancel(args = {}) {
        const jobId = this.ensureJobId(args.job_id);
        const job = this.jobService.get(jobId);
        if (!job) {
            return { success: false, code: 'NOT_FOUND', job_id: jobId };
        }
        const providerTool = job.provider?.tool;
        if (providerTool === 'mcp_ssh_manager') {
            if (!this.sshManager) {
                throw ToolError.internal({ code: 'SSH_MANAGER_UNAVAILABLE', message: 'SSH manager is not available' });
            }
            const killed = await this.sshManager.jobKill({ ...args, job_id: jobId });
            if (!killed.success) {
                return killed;
            }
            this.jobService.cancel(jobId, 'remote_kill');
            return { success: true, job: publicJobView(this.jobService.get(jobId)), killed };
        }
        const canceled = this.jobService.cancel(jobId, 'cancel');
        return { success: true, job: publicJobView(canceled) };
    }
    async jobForget(args = {}) {
        const jobId = this.ensureJobId(args.job_id);
        const removed = this.jobService.forget(jobId);
        return { success: true, job_id: jobId, removed };
    }
    async jobList(args = {}) {
        const jobs = this.jobService.list({ limit: args.limit, status: args.status });
        return { success: true, jobs: jobs.map(publicJobView), count: jobs.length };
    }
}
module.exports = JobManager;
