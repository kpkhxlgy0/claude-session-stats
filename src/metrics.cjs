'use strict';

const TokenFields = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'];
const MinimumResponseMs = 100;

function isRecord(value)
{
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identifier(value)
{
    return typeof value === 'string' && value.trim() ? value : null;
}

function tokenCount(value)
{
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function timestamp(value)
{
    const time = typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(time) ? time : null;
}

function estimateTps(responses, pendingKeys)
{
    let outputTokens = 0;
    let elapsedMs = 0;
    for (const [key, response] of responses)
    {
        if (pendingKeys.has(key) || !Number.isFinite(response.startedAt)
            || !Number.isFinite(response.completedAt) || tokenCount(response.output_tokens) === null) continue;
        const elapsed = response.completedAt - response.startedAt;
        if (!Number.isFinite(elapsed) || elapsed < MinimumResponseMs) continue;
        outputTokens += response.output_tokens;
        elapsedMs += elapsed;
        if (!Number.isSafeInteger(outputTokens) || !Number.isFinite(elapsedMs)) return null;
    }
    const rate = outputTokens / (elapsedMs / 1000);
    return Number.isFinite(rate) && rate > 0 ? rate : null;
}

function sumCounts(values)
{
    let total = 0;
    for (const value of values)
    {
        if (value === null) return null;
        total += value;
        if (!Number.isSafeInteger(total)) return null;
    }
    return total;
}

function hasUserContent(content)
{
    if (typeof content === 'string') return Boolean(content.trim());
    if (!Array.isArray(content)) return false;
    return content.some(block => isRecord(block) && identifier(block.type) && block.type !== 'tool_result'
        && (block.type !== 'text' || (typeof block.text === 'string' && Boolean(block.text.trim()))));
}

function mergeUsage(target, source)
{
    if (!isRecord(source)) return;
    for (const field of TokenFields)
    {
        const count = tokenCount(source[field]);
        if (count !== null && (target[field] === null || count > target[field])) target[field] = count;
    }
}

function createMetrics({ sessionId } = {})
{
    const turns = new Set();
    const userAliases = new Map();
    const responses = new Map();
    const requestAliases = new Map();
    const toolInputs = new Set();
    let currentSessionId = identifier(sessionId);
    let lastInputAt = null;

    function acceptsSession(row)
    {
        const incomingId = identifier(row.sessionId);
        if (!incomingId) return true;
        if (!currentSessionId) currentSessionId = incomingId;
        return incomingId === currentSessionId;
    }

    function ingestTurn(promptId, uuid)
    {
        const previous = uuid ? userAliases.get(uuid) : null;
        if (previous && (!promptId || previous.promptId)) return false;
        const key = promptId ? `prompt:${promptId}` : `uuid:${uuid}`;
        const isNew = !previous && !turns.has(key);
        if (previous) turns.delete(previous.key);
        turns.add(key);
        if (uuid) userAliases.set(uuid, { key, promptId });
        return isNew;
    }

    function responseKey(messageId, requestId)
    {
        const requestKey = `request:${requestId}`;
        const alias = requestAliases.get(requestId);
        if (!messageId) return alias === null ? null : alias || requestKey;
        const messageKey = `message:${messageId}`;
        if (requestId)
        {
            if (alias !== undefined && alias !== messageKey) requestAliases.set(requestId, null);
            else
            {
                requestAliases.set(requestId, messageKey);
                const fallback = responses.get(requestKey);
                if (fallback)
                {
                    if (responses.has(messageKey))
                    {
                        const target = responses.get(messageKey);
                        mergeUsage(target, fallback);
                        if (target.startedAt !== fallback.startedAt) target.startedAt = null;
                        target.completedAt = Math.max(target.completedAt ?? -Infinity, fallback.completedAt ?? -Infinity);
                    }
                    else responses.set(messageKey, fallback);
                    responses.delete(requestKey);
                }
            }
        }
        return messageKey;
    }

    // 返回 true 表示新输入，供远程读取器同步结束上一段响应流。
    function ingest(row)
    {
        if (!isRecord(row) || !isRecord(row.message) || row.isMeta || row.isSidechain
            || row.isCompactSummary || row.isSynthetic || row.isApiErrorMessage) return;
        const message = row.message;
        if (row.type === 'user' && message.role === 'user')
        {
            const promptId = identifier(row.promptId);
            const uuid = identifier(row.uuid);
            const isPrompt = hasUserContent(message.content);
            const isToolResult = Array.isArray(message.content)
                && message.content.some(block => isRecord(block) && block.type === 'tool_result');
            if ((!isPrompt && !isToolResult) || !acceptsSession(row)) return;
            if (!promptId && !uuid) { lastInputAt = null; return true; }
            const isNewPrompt = isPrompt && ingestTurn(promptId, uuid);
            let isNewToolResult = false;
            if (isToolResult)
            {
                const ids = message.content.filter(block => isRecord(block) && block.type === 'tool_result')
                    .map(block => identifier(block.tool_use_id));
                if (ids.some(id => id === null) && !uuid)
                {
                    lastInputAt = null;
                    return true;
                }
                const keys = ids.every(id => id !== null) ? ids.map(id => `tool:${id}`) : [`uuid:${uuid}`];
                isNewToolResult = keys.some(key => !toolInputs.has(key));
                for (const key of keys) toolInputs.add(key);
            }
            // 输入和工具返回分别去重，重放记录不重新开始计时。
            if (isNewPrompt || isNewToolResult)
            {
                lastInputAt = timestamp(row.timestamp);
                return true;
            }
        }
        else if (row.type === 'assistant' && message.role === 'assistant' && message.model !== '<synthetic>')
        {
            const messageId = identifier(message.id);
            const requestId = identifier(row.requestId);
            if ((!messageId && !requestId) || !acceptsSession(row)) return;
            const key = responseKey(messageId, requestId);
            if (!key) return;
            if (!responses.has(key))
            {
                responses.set(key, { ...Object.fromEntries(TokenFields.map(field => [field, null])),
                    startedAt: lastInputAt, completedAt: null });
            }
            const response = responses.get(key);
            const previousOutput = response.output_tokens;
            mergeUsage(response, message.usage);
            if (response.inputBoundary)
            {
                // Replayed inherited responses cannot turn a fork's idle time into generation time.
                if (response.output_tokens !== previousOutput) response.startedAt = null;
                return;
            }
            const end = timestamp(row.timestamp);
            response.completedAt = end === null ? null : Math.max(response.completedAt ?? end, end);
        }
    }

    function snapshot({ pendingResponseId, pendingResponseIds = [], pendingRequestIds = [] } = {})
    {
        const pendingKeys = new Set();
        for (const id of [pendingResponseId, ...pendingResponseIds])
            if (identifier(id)) pendingKeys.add(`message:${id}`);
        for (const id of pendingRequestIds)
            if (identifier(id)) pendingKeys.add(`request:${id}`);
        const totals = TokenFields.map(field => responses.size
            ? sumCounts([...responses.values()].map(usage => usage[field])) : null);
        const inputTokens = sumCounts(totals.slice(0, 3));
        const outputTokens = totals[3];
        const cachedInputTokens = totals[2];
        const totalTokens = sumCounts([inputTokens, outputTokens]);
        const cacheHit = inputTokens > 0 && cachedInputTokens !== null
            ? cachedInputTokens / inputTokens : null;
        return {
            turns: turns.size,
            steps: responses.size || null,
            totalTokens,
            inputTokens,
            outputTokens,
            cachedInputTokens,
            cacheHit,
            // 汇总会话内有效响应的输出和日志耗时；包含首字等待，排除工具执行间隔和未完成响应。
            tps: estimateTps(responses, pendingKeys),
            usageComplete: totalTokens !== null
        };
    }

    function resetInput()
    {
        lastInputAt = null;
        for (const response of responses.values()) response.inputBoundary = true;
    }

    return { ingest, snapshot, resetInput };
}

module.exports = { createMetrics };
