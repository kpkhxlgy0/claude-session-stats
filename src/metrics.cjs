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

function estimateTps(response)
{
    if (!response || response.startedAt === null || response.completedAt === null
        || !(response.output_tokens > 0)) return null;
    const elapsed = response.completedAt - response.startedAt;
    return elapsed >= MinimumResponseMs ? response.output_tokens / (elapsed / 1000) : null;
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
    const inputRows = new Set();
    let currentSessionId = identifier(sessionId);
    let lastInputAt = null;
    let lastResponse = null;

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
        if (previous && (!promptId || previous.promptId)) return;
        const key = promptId ? `prompt:${promptId}` : `uuid:${uuid}`;
        if (previous) turns.delete(previous.key);
        turns.add(key);
        if (uuid) userAliases.set(uuid, { key, promptId });
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
                        if (lastResponse === fallback) lastResponse = target;
                    }
                    else responses.set(messageKey, fallback);
                    responses.delete(requestKey);
                }
            }
        }
        return messageKey;
    }

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
            if (!promptId && !uuid) { lastInputAt = null; lastResponse = null; return; }
            const inputKey = uuid ? `uuid:${uuid}` : `prompt:${promptId}`;
            if (!inputRows.has(inputKey))
            {
                inputRows.add(inputKey);
                lastInputAt = timestamp(row.timestamp);
                lastResponse = null;
            }
            if (isPrompt) ingestTurn(promptId, uuid);
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
                lastResponse = { ...Object.fromEntries(TokenFields.map(field => [field, null])),
                    startedAt: lastInputAt, completedAt: null };
                responses.set(key, lastResponse);
            }
            const response = responses.get(key);
            mergeUsage(response, message.usage);
            const end = timestamp(row.timestamp);
            response.completedAt = end === null ? null : Math.max(response.completedAt ?? end, end);
        }
    }

    function snapshot()
    {
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
            // 使用最近响应的日志时间差估算；包含首字等待，工具返回后重新计时。
            tps: estimateTps(lastResponse),
            usageComplete: totalTokens !== null
        };
    }

    return { ingest, snapshot };
}

module.exports = { createMetrics };
