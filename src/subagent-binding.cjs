'use strict';

// Keep this factory self-contained: the main process serializes it into the page world.
function createSubagentBindings() {
    const PaneSelector = '[data-pane-root][data-perf-screen="tasks"]';
    const AgentId = /^[A-Za-z0-9_-]{1,64}$/;
    const Key = /^[A-Za-z0-9_-]{1,128}$/;
    const MaxNodes = 3000;

    function route(win) {
        try {
            const url = new win.URL(win.location.href);
            if (url.username || url.password) return null;
            if (!(url.protocol === 'app:' && url.hostname === 'localhost' && !url.port)
                && url.origin !== 'https://claude.ai') return null;
            const local = /^\/epitaxy\/(local_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/?$/i
                .exec(url.pathname);
            if (local) return { sessionId: local[1], type: 'local', remote: false };
            const remote = /^\/(?:epitaxy|code)\/(session_[A-Za-z0-9_-]{1,128})\/?$/.exec(url.pathname);
            return remote ? { sessionId: remote[1], type: 'bridge', remote: true } : null;
        } catch { return null; }
    }
    function visible(root, win) {
        if (!root?.isConnected || !root.getClientRects().length
            || root.closest('[hidden],[inert],[aria-hidden="true"],dialog,[role="dialog"],[role="menu"]')) return false;
        for (let node = root; node; node = node.parentElement) {
            const style = win.getComputedStyle(node);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
        }
        return true;
    }
    function committed(fiber) {
        for (const candidate of [fiber, fiber?.alternate]) {
            if (!candidate) continue;
            let top = candidate;
            const seen = new Set();
            while (top.return && seen.size < MaxNodes && !seen.has(top)) {
                seen.add(top); top = top.return;
            }
            if (!top.return && top.tag === 3 && top.stateNode?.current === top) return candidate;
        }
        return null;
    }
    function sessionMatches(ref, selected) {
        return ref?.type === selected.type && ref.id === selected.sessionId;
    }
    function rootFamily(fiber) {
        const seen = new Set();
        let top = fiber;
        while (top?.return && seen.size < MaxNodes && !seen.has(top)) {
            seen.add(top); top = top.return;
        }
        return top && !top.return && top.tag === 3 ? top.stateNode : null;
    }
    function messagePresentation(node, root, paneFiber) {
        const element = node.stateNode, props = node.memoizedProps;
        if (node.tag !== 5 || element?.nodeType !== 1 || !props
            || !(Object.hasOwn(props, 'data-cds-bubble-stack') && element.matches('[data-cds-bubble-stack]')
                || props['data-cds'] === 'AssistantMessage' && element.getAttribute('data-cds') === 'AssistantMessage')
            || !root.contains(element)
            || element.closest('[data-pane-root]') !== root) return false;
        const keys = Object.getOwnPropertyNames(element).filter(key => key.startsWith('__reactFiber$'));
        if (keys.length !== 1) return false;
        const host = element[keys[0]];
        if (host !== node && host !== node.alternate || host?.tag !== 5 || host.stateNode !== element
            || host !== node && host.alternate !== node) return false;
        const family = rootFamily(paneFiber);
        if (!family || rootFamily(host) !== family) return false;
        const alternate = paneFiber.alternate?.tag === 5 && paneFiber.alternate.stateNode === root
            && paneFiber.alternate.alternate === paneFiber ? paneFiber.alternate : null;
        const seen = new Set();
        let parent = node.return;
        while (parent && parent !== paneFiber && parent !== alternate && seen.size < MaxNodes && !seen.has(parent)) {
            seen.add(parent); parent = parent.return;
        }
        return parent === paneFiber || alternate !== null && parent === alternate && rootFamily(alternate) === family;
    }
    function resolveSubagent(root, win) {
        try {
            const selected = route(win);
            if (!selected || !root?.matches(PaneSelector) || !visible(root, win)) return null;
            const keys = Object.getOwnPropertyNames(root).filter(key => key.startsWith('__reactFiber$'));
            if (keys.length !== 1) return null;
            const fiber = committed(root[keys[0]]);
            if (!fiber || fiber.stateNode !== root) return null;
            const stack = [fiber], seen = new Set(), views = [], details = [];
            while (stack.length) {
                const node = stack.pop();
                if (!node || seen.has(node) || seen.size >= MaxNodes) return null;
                seen.add(node);
                if (node !== fiber && node.stateNode?.nodeType === 1
                    && node.stateNode.matches('[data-pane-root]')) continue;
                const props = node.memoizedProps;
                if (props && typeof props === 'object') {
                    if (props.view && typeof props.view.kind === 'string'
                        && Object.hasOwn(props, 'sessionRef')) views.push(props);
                    if (Object.hasOwn(props, 'openedToolUseId') && props.paneView) details.push(props);
                }
                // Bubble descendants render message bodies; their sibling controls own pane identity.
                if (messagePresentation(node, root, fiber)) continue;
                // A pane's siblings belong to its parent; only descend through this pane's own children.
                for (let child = node.child; child; child = child.sibling) {
                    if (stack.length + seen.size >= MaxNodes || stack.includes(child)) return null;
                    stack.push(child);
                }
            }
            if (!views.length) return null;
            let toolUseId = null;
            for (const props of views) {
                const id = props.view.toolUseId;
                if (props.view.kind !== 'subagent' || !sessionMatches(props.sessionRef, selected)
                    || typeof id !== 'string' || !id.length
                    || id.length > 256 || toolUseId !== null && toolUseId !== id) return null;
                toolUseId = id;
            }
            let agentId = null;
            for (const props of details) {
                if (props.openedToolUseId !== toolUseId) continue;
                const id = props.paneView.agentId;
                if (!sessionMatches(props.sessionRef, selected) || typeof id !== 'string' || !AgentId.test(id)
                    || props.task?.toolUseId !== undefined && props.task.toolUseId !== toolUseId
                    || props.task?.taskId !== undefined && props.task.taskId !== id
                    || agentId !== null && agentId !== id) return null;
                agentId = id;
            }
            return agentId === null ? null : { sessionId: selected.sessionId, agentId, remote: selected.remote };
        } catch { return null; }
    }
    function readBindings(win = window) {
        try {
            if (win.document.visibilityState === 'hidden') return [];
            const roots = [...win.document.querySelectorAll(`${PaneSelector}[data-session-stats-key]`)];
            if (roots.length > 64) return [];
            const counts = new Map();
            for (const root of roots) {
                const key = root.dataset.sessionStatsKey;
                counts.set(key, (counts.get(key) || 0) + 1);
            }
            const result = [];
            for (const root of roots) {
                const key = root.dataset.sessionStatsKey;
                if (!Key.test(key) || counts.get(key) !== 1) continue;
                const bound = resolveSubagent(root, win);
                if (bound) result.push({ key, bound });
            }
            return result;
        } catch { return []; }
    }
    return { resolveSubagent, readBindings };
}

module.exports = { createSubagentBindings };
