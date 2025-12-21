/**
 * Cloud Code Client for Antigravity
 *
 * Communicates with Google's Cloud Code internal API using the
 * v1internal:streamGenerateContent endpoint with proper request wrapping.
 *
 * Supports multi-account load balancing with automatic failover.
 *
 * Based on: https://github.com/NoeFabris/opencode-antigravity-auth
 */

import crypto from 'crypto';
import {
    ANTIGRAVITY_ENDPOINT_FALLBACKS,
    ANTIGRAVITY_HEADERS,
    AVAILABLE_MODELS,
    MAX_RETRIES
} from './constants.js';
import {
    mapModelName,
    convertAnthropicToGoogle,
    convertGoogleToAnthropic
} from './format-converter.js';
import { formatDuration, sleep } from './account-manager.js';

/**
 * Check if an error is a rate limit error (429 or RESOURCE_EXHAUSTED)
 */
function is429Error(error) {
    const msg = (error.message || '').toLowerCase();
    return msg.includes('429') ||
        msg.includes('resource_exhausted') ||
        msg.includes('quota_exhausted') ||
        msg.includes('rate limit');
}

/**
 * Check if an error is an auth-invalid error (credentials need re-authentication)
 */
function isAuthInvalidError(error) {
    const msg = (error.message || '').toUpperCase();
    return msg.includes('AUTH_INVALID') ||
        msg.includes('INVALID_GRANT') ||
        msg.includes('TOKEN REFRESH FAILED');
}

/**
 * Parse reset time from HTTP response or error
 * Checks headers first, then error message body
 * Returns milliseconds or null if not found
 *
 * @param {Response|Error} responseOrError - HTTP Response object or Error
 * @param {string} errorText - Optional error body text
 */
function parseResetTime(responseOrError, errorText = '') {
    let resetMs = null;

    // If it's a Response object, check headers first
    if (responseOrError && typeof responseOrError.headers?.get === 'function') {
        const headers = responseOrError.headers;

        // Standard Retry-After header (seconds or HTTP date)
        const retryAfter = headers.get('retry-after');
        if (retryAfter) {
            const seconds = parseInt(retryAfter, 10);
            if (!isNaN(seconds)) {
                resetMs = seconds * 1000;
                console.log(`[CloudCode] Retry-After header: ${seconds}s`);
            } else {
                // Try parsing as HTTP date
                const date = new Date(retryAfter);
                if (!isNaN(date.getTime())) {
                    resetMs = date.getTime() - Date.now();
                    if (resetMs > 0) {
                        console.log(`[CloudCode] Retry-After date: ${retryAfter}`);
                    } else {
                        resetMs = null;
                    }
                }
            }
        }

        // x-ratelimit-reset (Unix timestamp in seconds)
        if (!resetMs) {
            const ratelimitReset = headers.get('x-ratelimit-reset');
            if (ratelimitReset) {
                const resetTimestamp = parseInt(ratelimitReset, 10) * 1000;
                resetMs = resetTimestamp - Date.now();
                if (resetMs > 0) {
                    console.log(`[CloudCode] x-ratelimit-reset: ${new Date(resetTimestamp).toISOString()}`);
                } else {
                    resetMs = null;
                }
            }
        }

        // x-ratelimit-reset-after (seconds)
        if (!resetMs) {
            const resetAfter = headers.get('x-ratelimit-reset-after');
            if (resetAfter) {
                const seconds = parseInt(resetAfter, 10);
                if (!isNaN(seconds) && seconds > 0) {
                    resetMs = seconds * 1000;
                    console.log(`[CloudCode] x-ratelimit-reset-after: ${seconds}s`);
                }
            }
        }
    }

    // If no header found, try parsing from error message/body
    if (!resetMs) {
        const msg = (responseOrError instanceof Error ? responseOrError.message : errorText) || '';

        // Try to extract "retry-after-ms" or "retryDelay" - check seconds format first (e.g. "7739.23s")
        const secMatch = msg.match(/(?:retry[-_]?after[-_]?ms|retryDelay)[:\s"]+([\d\.]+)(?:s\b|s")/i);
        if (secMatch) {
            resetMs = Math.ceil(parseFloat(secMatch[1]) * 1000);
            console.log(`[CloudCode] Parsed retry seconds from body (precise): ${resetMs}ms`);
        }

        if (!resetMs) {
            // Check for ms (explicit "ms" suffix or implicit if no suffix)
            // Rejects "s" suffix or floats (handled above)
            const msMatch = msg.match(/(?:retry[-_]?after[-_]?ms|retryDelay)[:\s"]+(\d+)(?:\s*ms)?(?![\w.])/i);
            if (msMatch) {
                resetMs = parseInt(msMatch[1], 10);
                console.log(`[CloudCode] Parsed retry-after-ms from body: ${resetMs}ms`);
            }
        }

        // Try to extract seconds value like "retry after 60 seconds"
        if (!resetMs) {
            const secMatch = msg.match(/retry\s+(?:after\s+)?(\d+)\s*(?:sec|s\b)/i);
            if (secMatch) {
                resetMs = parseInt(secMatch[1], 10) * 1000;
                console.log(`[CloudCode] Parsed retry seconds from body: ${secMatch[1]}s`);
            }
        }

        // Try to extract duration like "1h23m45s" or "23m45s" or "45s"
        if (!resetMs) {
            const durationMatch = msg.match(/(\d+)h(\d+)m(\d+)s|(\d+)m(\d+)s|(\d+)s/i);
            if (durationMatch) {
                if (durationMatch[1]) {
                    const hours = parseInt(durationMatch[1], 10);
                    const minutes = parseInt(durationMatch[2], 10);
                    const seconds = parseInt(durationMatch[3], 10);
                    resetMs = (hours * 3600 + minutes * 60 + seconds) * 1000;
                } else if (durationMatch[4]) {
                    const minutes = parseInt(durationMatch[4], 10);
                    const seconds = parseInt(durationMatch[5], 10);
                    resetMs = (minutes * 60 + seconds) * 1000;
                } else if (durationMatch[6]) {
                    resetMs = parseInt(durationMatch[6], 10) * 1000;
                }
                if (resetMs) {
                    console.log(`[CloudCode] Parsed duration from body: ${formatDuration(resetMs)}`);
                }
            }
        }

        // Try to extract ISO timestamp or Unix timestamp
        if (!resetMs) {
            const isoMatch = msg.match(/reset[:\s"]+(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)/i);
            if (isoMatch) {
                const resetTime = new Date(isoMatch[1]).getTime();
                if (!isNaN(resetTime)) {
                    resetMs = resetTime - Date.now();
                    if (resetMs > 0) {
                        console.log(`[CloudCode] Parsed ISO reset time: ${isoMatch[1]}`);
                    } else {
                        resetMs = null;
                    }
                }
            }
        }
    }

    return resetMs;
}

/**
 * Build the wrapped request body for Cloud Code API
 */
function buildCloudCodeRequest(anthropicRequest, projectId) {
    const model = mapModelName(anthropicRequest.model);
    const googleRequest = convertAnthropicToGoogle(anthropicRequest);

    // Use random session ID for API tracking
    googleRequest.sessionId = crypto.randomUUID();

    const payload = {
        project: projectId,
        model: model,
        request: googleRequest,
        userAgent: 'antigravity',
        requestId: 'agent-' + crypto.randomUUID()
    };

    return payload;
}

/**
 * Build headers for Cloud Code API requests
 */
function buildHeaders(token, model, accept = 'application/json') {
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...ANTIGRAVITY_HEADERS
    };

    // Add interleaved thinking header for Claude thinking models
    const isThinkingModel = model.toLowerCase().includes('thinking');
    if (isThinkingModel) {
        headers['anthropic-beta'] = 'interleaved-thinking-2025-05-14';
    }

    if (accept !== 'application/json') {
        headers['Accept'] = accept;
    }

    return headers;
}

/**
 * Send a non-streaming request to Cloud Code with multi-account support
 * Uses SSE endpoint for thinking models (non-streaming doesn't return thinking blocks)
 *
 * @param {Object} anthropicRequest - The Anthropic-format request
 * @param {AccountManager} accountManager - The account manager instance
 */
export async function sendMessage(anthropicRequest, accountManager) {
    const model = mapModelName(anthropicRequest.model);
    const isThinkingModel = model.toLowerCase().includes('thinking');

    // Retry loop with account failover
    // Ensure we try at least as many times as there are accounts to cycle through everyone
    // +1 to ensure we hit the "all accounts rate-limited" check at the start of the next loop
    const maxAttempts = Math.max(MAX_RETRIES, accountManager.getAccountCount() + 1);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        // Get next available account
        let account = accountManager.pickNext();

        // Handle all accounts rate-limited
        if (!account) {
            if (accountManager.isAllRateLimited()) {
                const waitMs = accountManager.getMinWaitTimeMs();
                const resetTime = new Date(Date.now() + waitMs).toISOString();

                // If wait time is too long (> 2 minutes), throw error immediately
                if (waitMs > 120000) {
                    throw new Error(
                        `RESOURCE_EXHAUSTED: Rate limited. Quota will reset after ${formatDuration(waitMs)}. Next available: ${resetTime}`
                    );
                }

                if (accountManager.getAccountCount() === 1) {
                    // Single account mode: wait for reset
                    console.log(`[CloudCode] Single account rate-limited. Waiting ${formatDuration(waitMs)}...`);
                    await sleep(waitMs);
                    accountManager.clearExpiredLimits();
                    account = accountManager.pickNext();
                } else {
                    // Multi-account: all exhausted - throw proper error
                    throw new Error(
                        `RESOURCE_EXHAUSTED: All ${accountManager.getAccountCount()} accounts rate-limited. ` +
                        `quota will reset after ${formatDuration(waitMs)}. Next available: ${resetTime}`
                    );
                }
            }

            if (!account) {
                throw new Error('No accounts available');
            }
        }

        try {
            // Get token and project for this account
            const token = await accountManager.getTokenForAccount(account);
            const project = await accountManager.getProjectForAccount(account, token);
            const payload = buildCloudCodeRequest(anthropicRequest, project);

            console.log(`[CloudCode] Sending request for model: ${model}`);

            // Try each endpoint
            let lastError = null;
            for (const endpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
                try {
                    const url = isThinkingModel
                        ? `${endpoint}/v1internal:streamGenerateContent?alt=sse`
                        : `${endpoint}/v1internal:generateContent`;

                    const response = await fetch(url, {
                        method: 'POST',
                        headers: buildHeaders(token, model, isThinkingModel ? 'text/event-stream' : 'application/json'),
                        body: JSON.stringify(payload)
                    });

                    if (!response.ok) {
                        const errorText = await response.text();
                        console.log(`[CloudCode] Error at ${endpoint}: ${response.status} - ${errorText}`);

                        if (response.status === 401) {
                            // Auth error - clear caches and retry with fresh token
                            console.log('[CloudCode] Auth error, refreshing token...');
                            accountManager.clearTokenCache(account.email);
                            accountManager.clearProjectCache(account.email);
                            continue;
                        }

                        if (response.status === 429) {
                            // Rate limited on this endpoint - try next endpoint first (DAILY → PROD)
                            console.log(`[CloudCode] Rate limited at ${endpoint}, trying next endpoint...`);
                            const resetMs = parseResetTime(response, errorText);
                            // Keep minimum reset time across all 429 responses
                            if (!lastError?.is429 || (resetMs && (!lastError.resetMs || resetMs < lastError.resetMs))) {
                                lastError = { is429: true, response, errorText, resetMs };
                            }
                            continue;
                        }

                        if (response.status >= 400) {
                            lastError = new Error(`API error ${response.status}: ${errorText}`);
                            continue;
                        }
                    }

                    // For thinking models, parse SSE and accumulate all parts
                    if (isThinkingModel) {
                        return await parseThinkingSSEResponse(response, anthropicRequest.model);
                    }

                    // Non-thinking models use regular JSON
                    const data = await response.json();
                    console.log('[CloudCode] Response received');
                    return convertGoogleToAnthropic(data, anthropicRequest.model);

                } catch (endpointError) {
                    if (is429Error(endpointError)) {
                        throw endpointError; // Re-throw to trigger account switch
                    }
                    console.log(`[CloudCode] Error at ${endpoint}:`, endpointError.message);
                    lastError = endpointError;
                }
            }

            // If all endpoints failed for this account
            if (lastError) {
                // If all endpoints returned 429, mark account as rate-limited
                if (lastError.is429) {
                    console.log(`[CloudCode] All endpoints rate-limited for ${account.email}`);
                    accountManager.markRateLimited(account.email, lastError.resetMs);
                    throw new Error(`Rate limited: ${lastError.errorText}`);
                }
                throw lastError;
            }

        } catch (error) {
            if (is429Error(error)) {
                // Rate limited - already marked, continue to next account
                console.log(`[CloudCode] Account ${account.email} rate-limited, trying next...`);
                continue;
            }
            if (isAuthInvalidError(error)) {
                // Auth invalid - already marked, continue to next account
                console.log(`[CloudCode] Account ${account.email} has invalid credentials, trying next...`);
                continue;
            }
            // Non-rate-limit error: throw immediately
            throw error;
        }
    }

    throw new Error('Max retries exceeded');
}

/**
 * Parse SSE response for thinking models and accumulate all parts
 */
async function parseThinkingSSEResponse(response, originalModel) {
    let accumulatedThinkingText = '';
    let accumulatedThinkingSignature = '';
    let accumulatedText = '';
    const finalParts = [];
    let usageMetadata = {};
    let finishReason = 'STOP';

    const flushThinking = () => {
        if (accumulatedThinkingText) {
            finalParts.push({
                thought: true,
                text: accumulatedThinkingText,
                thoughtSignature: accumulatedThinkingSignature
            });
            accumulatedThinkingText = '';
            accumulatedThinkingSignature = '';
        }
    };

    const flushText = () => {
        if (accumulatedText) {
            finalParts.push({ text: accumulatedText });
            accumulatedText = '';
        }
    };

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const jsonText = line.slice(5).trim();
            if (!jsonText) continue;

            try {
                const data = JSON.parse(jsonText);
                const innerResponse = data.response || data;

                if (innerResponse.usageMetadata) {
                    usageMetadata = innerResponse.usageMetadata;
                }

                const candidates = innerResponse.candidates || [];
                const firstCandidate = candidates[0] || {};
                if (firstCandidate.finishReason) {
                    finishReason = firstCandidate.finishReason;
                }

                const parts = firstCandidate.content?.parts || [];
                for (const part of parts) {
                    if (part.thought === true) {
                        flushText();
                        accumulatedThinkingText += (part.text || '');
                        if (part.thoughtSignature) {
                            accumulatedThinkingSignature = part.thoughtSignature;
                        }
                    } else if (part.functionCall) {
                        flushThinking();
                        flushText();
                        finalParts.push(part);
                    } else if (part.text !== undefined) {
                        if (!part.text) continue;
                        flushThinking();
                        accumulatedText += part.text;
                    }
                }
            } catch (e) { /* skip parse errors */ }
        }
    }

    flushThinking();
    flushText();

    const accumulatedResponse = {
        candidates: [{ content: { parts: finalParts }, finishReason }],
        usageMetadata
    };

    const partTypes = finalParts.map(p => p.thought ? 'thought' : (p.functionCall ? 'functionCall' : 'text'));
    console.log('[CloudCode] Response received (SSE), part types:', partTypes);
    if (finalParts.some(p => p.thought)) {
        const thinkingPart = finalParts.find(p => p.thought);
        console.log('[CloudCode] Thinking signature length:', thinkingPart?.thoughtSignature?.length || 0);
    }

    return convertGoogleToAnthropic(accumulatedResponse, originalModel);
}

/**
 * Send a streaming request to Cloud Code with multi-account support
 * Streams events in real-time as they arrive from the server
 *
 * @param {Object} anthropicRequest - The Anthropic-format request
 * @param {AccountManager} accountManager - The account manager instance
 */
export async function* sendMessageStream(anthropicRequest, accountManager) {
    const model = mapModelName(anthropicRequest.model);

    // Retry loop with account failover
    // Ensure we try at least as many times as there are accounts to cycle through everyone
    // +1 to ensure we hit the "all accounts rate-limited" check at the start of the next loop
    const maxAttempts = Math.max(MAX_RETRIES, accountManager.getAccountCount() + 1);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        // Get next available account
        let account = accountManager.pickNext();

        // Handle all accounts rate-limited
        if (!account) {
            if (accountManager.isAllRateLimited()) {
                const waitMs = accountManager.getMinWaitTimeMs();
                const resetTime = new Date(Date.now() + waitMs).toISOString();

                // If wait time is too long (> 2 minutes), throw error immediately
                if (waitMs > 120000) {
                    throw new Error(
                        `RESOURCE_EXHAUSTED: Rate limited. Quota will reset after ${formatDuration(waitMs)}. Next available: ${resetTime}`
                    );
                }

                if (accountManager.getAccountCount() === 1) {
                    // Single account mode: wait for reset
                    console.log(`[CloudCode] Single account rate-limited. Waiting ${formatDuration(waitMs)}...`);
                    await sleep(waitMs);
                    accountManager.clearExpiredLimits();
                    account = accountManager.pickNext();
                } else {
                    // Multi-account: all exhausted - throw proper error
                    throw new Error(
                        `RESOURCE_EXHAUSTED: All ${accountManager.getAccountCount()} accounts rate-limited. ` +
                        `quota will reset after ${formatDuration(waitMs)}. Next available: ${resetTime}`
                    );
                }
            }

            if (!account) {
                throw new Error('No accounts available');
            }
        }

        try {
            // Get token and project for this account
            const token = await accountManager.getTokenForAccount(account);
            const project = await accountManager.getProjectForAccount(account, token);
            const payload = buildCloudCodeRequest(anthropicRequest, project);

            console.log(`[CloudCode] Starting stream for model: ${model}`);

            // Try each endpoint for streaming
            let lastError = null;
            for (const endpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
                try {
                    const url = `${endpoint}/v1internal:streamGenerateContent?alt=sse`;

                    const response = await fetch(url, {
                        method: 'POST',
                        headers: buildHeaders(token, model, 'text/event-stream'),
                        body: JSON.stringify(payload)
                    });

                    if (!response.ok) {
                        const errorText = await response.text();
                        console.log(`[CloudCode] Stream error at ${endpoint}: ${response.status} - ${errorText}`);

                        if (response.status === 401) {
                            // Auth error - clear caches and retry
                            accountManager.clearTokenCache(account.email);
                            accountManager.clearProjectCache(account.email);
                            continue;
                        }

                        if (response.status === 429) {
                            // Rate limited on this endpoint - try next endpoint first (DAILY → PROD)
                            console.log(`[CloudCode] Stream rate limited at ${endpoint}, trying next endpoint...`);
                            const resetMs = parseResetTime(response, errorText);
                            // Keep minimum reset time across all 429 responses
                            if (!lastError?.is429 || (resetMs && (!lastError.resetMs || resetMs < lastError.resetMs))) {
                                lastError = { is429: true, response, errorText, resetMs };
                            }
                            continue;
                        }

                        lastError = new Error(`API error ${response.status}: ${errorText}`);
                        continue;
                    }

                    // Stream the response - yield events as they arrive
                    yield* streamSSEResponse(response, anthropicRequest.model);

                    console.log('[CloudCode] Stream completed');
                    return;

                } catch (endpointError) {
                    if (is429Error(endpointError)) {
                        throw endpointError; // Re-throw to trigger account switch
                    }
                    console.log(`[CloudCode] Stream error at ${endpoint}:`, endpointError.message);
                    lastError = endpointError;
                }
            }

            // If all endpoints failed for this account
            if (lastError) {
                // If all endpoints returned 429, mark account as rate-limited
                if (lastError.is429) {
                    console.log(`[CloudCode] All endpoints rate-limited for ${account.email}`);
                    accountManager.markRateLimited(account.email, lastError.resetMs);
                    throw new Error(`Rate limited: ${lastError.errorText}`);
                }
                throw lastError;
            }

        } catch (error) {
            if (is429Error(error)) {
                // Rate limited - already marked, continue to next account
                console.log(`[CloudCode] Account ${account.email} rate-limited, trying next...`);
                continue;
            }
            if (isAuthInvalidError(error)) {
                // Auth invalid - already marked, continue to next account
                console.log(`[CloudCode] Account ${account.email} has invalid credentials, trying next...`);
                continue;
            }
            // Non-rate-limit error: throw immediately
            throw error;
        }
    }

    throw new Error('Max retries exceeded');
}

/**
 * Stream SSE response and yield Anthropic-format events
 */
async function* streamSSEResponse(response, originalModel) {
    const messageId = `msg_${crypto.randomBytes(16).toString('hex')}`;
    let hasEmittedStart = false;
    let blockIndex = 0;
    let currentBlockType = null;
    let currentThinkingSignature = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason = 'end_turn';

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            if (!line.startsWith('data:')) continue;

            const jsonText = line.slice(5).trim();
            if (!jsonText) continue;

            try {
                const data = JSON.parse(jsonText);
                const innerResponse = data.response || data;

                // Extract usage metadata
                const usage = innerResponse.usageMetadata;
                if (usage) {
                    inputTokens = usage.promptTokenCount || inputTokens;
                    outputTokens = usage.candidatesTokenCount || outputTokens;
                }

                const candidates = innerResponse.candidates || [];
                const firstCandidate = candidates[0] || {};
                const content = firstCandidate.content || {};
                const parts = content.parts || [];

                // Emit message_start on first data
                if (!hasEmittedStart && parts.length > 0) {
                    hasEmittedStart = true;
                    yield {
                        type: 'message_start',
                        message: {
                            id: messageId,
                            type: 'message',
                            role: 'assistant',
                            content: [],
                            model: originalModel,
                            stop_reason: null,
                            stop_sequence: null,
                            usage: { input_tokens: inputTokens, output_tokens: 0 }
                        }
                    };
                }

                // Process each part
                for (const part of parts) {
                    if (part.thought === true) {
                        // Handle thinking block
                        const text = part.text || '';
                        const signature = part.thoughtSignature || '';

                        if (currentBlockType !== 'thinking') {
                            if (currentBlockType !== null) {
                                yield { type: 'content_block_stop', index: blockIndex };
                                blockIndex++;
                            }
                            currentBlockType = 'thinking';
                            currentThinkingSignature = '';
                            yield {
                                type: 'content_block_start',
                                index: blockIndex,
                                content_block: { type: 'thinking', thinking: '' }
                            };
                        }

                        if (signature && signature.length >= 50) {
                            currentThinkingSignature = signature;
                        }

                        yield {
                            type: 'content_block_delta',
                            index: blockIndex,
                            delta: { type: 'thinking_delta', thinking: text }
                        };

                    } else if (part.text !== undefined) {
                        // Skip empty text parts
                        if (!part.text || part.text.trim().length === 0) {
                            continue;
                        }

                        // Handle regular text
                        if (currentBlockType !== 'text') {
                            if (currentBlockType === 'thinking' && currentThinkingSignature) {
                                yield {
                                    type: 'content_block_delta',
                                    index: blockIndex,
                                    delta: { type: 'signature_delta', signature: currentThinkingSignature }
                                };
                                currentThinkingSignature = '';
                            }
                            if (currentBlockType !== null) {
                                yield { type: 'content_block_stop', index: blockIndex };
                                blockIndex++;
                            }
                            currentBlockType = 'text';
                            yield {
                                type: 'content_block_start',
                                index: blockIndex,
                                content_block: { type: 'text', text: '' }
                            };
                        }

                        yield {
                            type: 'content_block_delta',
                            index: blockIndex,
                            delta: { type: 'text_delta', text: part.text }
                        };

                    } else if (part.functionCall) {
                        // Handle tool use
                        if (currentBlockType === 'thinking' && currentThinkingSignature) {
                            yield {
                                type: 'content_block_delta',
                                index: blockIndex,
                                delta: { type: 'signature_delta', signature: currentThinkingSignature }
                            };
                            currentThinkingSignature = '';
                        }
                        if (currentBlockType !== null) {
                            yield { type: 'content_block_stop', index: blockIndex };
                            blockIndex++;
                        }
                        currentBlockType = 'tool_use';
                        stopReason = 'tool_use';

                        const toolId = part.functionCall.id || `toolu_${crypto.randomBytes(12).toString('hex')}`;

                        yield {
                            type: 'content_block_start',
                            index: blockIndex,
                            content_block: {
                                type: 'tool_use',
                                id: toolId,
                                name: part.functionCall.name,
                                input: {}
                            }
                        };

                        yield {
                            type: 'content_block_delta',
                            index: blockIndex,
                            delta: {
                                type: 'input_json_delta',
                                partial_json: JSON.stringify(part.functionCall.args || {})
                            }
                        };
                    }
                }

                // Check finish reason
                if (firstCandidate.finishReason) {
                    if (firstCandidate.finishReason === 'MAX_TOKENS') {
                        stopReason = 'max_tokens';
                    } else if (firstCandidate.finishReason === 'STOP') {
                        stopReason = 'end_turn';
                    }
                }

            } catch (parseError) {
                console.log('[CloudCode] SSE parse error:', parseError.message);
            }
        }
    }

    // Handle no content received
    if (!hasEmittedStart) {
        console.log('[CloudCode] WARNING: No content parts received, emitting empty message');
        yield {
            type: 'message_start',
            message: {
                id: messageId,
                type: 'message',
                role: 'assistant',
                content: [],
                model: originalModel,
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: inputTokens, output_tokens: 0 }
            }
        };

        yield {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' }
        };
        yield {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: '[No response received from API]' }
        };
        yield { type: 'content_block_stop', index: 0 };
    } else {
        // Close any open block
        if (currentBlockType !== null) {
            if (currentBlockType === 'thinking' && currentThinkingSignature) {
                yield {
                    type: 'content_block_delta',
                    index: blockIndex,
                    delta: { type: 'signature_delta', signature: currentThinkingSignature }
                };
            }
            yield { type: 'content_block_stop', index: blockIndex };
        }
    }

    // Emit message_delta and message_stop
    yield {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: outputTokens }
    };

    yield { type: 'message_stop' };
}


/**
 * List available models
 */
export function listModels() {
    return {
        object: 'list',
        data: AVAILABLE_MODELS.map(m => ({
            id: m.id,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: 'anthropic',
            description: m.description
        }))
    };
}

export default {
    sendMessage,
    sendMessageStream,
    listModels
};
