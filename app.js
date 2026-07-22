(() => {
  "use strict";

  const NODE_PARENT = 0;
  const NODE_LABEL = 1;
  const NODE_CHILDREN = 2;
  const NODE_MASK = 3;
  const NODE_ENDPOINT_MASK = 4;
  const NODE_RETAINED_MASK = 5;
  const NODE_CONFIRMED_NOT_FOUND = 6;
  const HOST_NAME = 0;
  const HOST_ROOT = 1;
  const HOST_COUNTS = 2;
  const HOST_RETAINED_COUNTS = 3;
  const PAGE_SIZE = 50;
  const STORED_RESULT_LIMIT = 5000;
  const AUTO_EXPAND_MATCH_LIMIT = 250;
  const CHILD_PAGE = 200;
  const KEYWORD_POLL_MS = 20000;

  // Institution (dataset) and reviewer come from the URL; the landing page links
  // carry them. Storage keys are namespaced per (institution, user) so a browser
  // switching between reviewers keeps their local caches apart.
  const PARAMS = new URLSearchParams(window.location.search);
  const USER = (PARAMS.get("user") || "sudhamshu").toLowerCase();
  let INSTITUTION = (PARAMS.get("institution") || "chase").toLowerCase();
  const REVIEW_STORAGE_KEY = `urltree-review-${INSTITUTION}-${USER}`;
  const SEARCH_STORAGE_KEY = `urltree-search-${INSTITUTION}`; // keywords are shared

  // Union is the only view now (source tabs removed), so the mask is always 7.
  const sourceConfig = {
    union: {
      title: "Union URL tree",
      description: "Unique host-and-path URLs across Common Crawl, Wayback, and sitemap discovery. Query parameters are removed.",
      countIndex: 0,
      badge: "",
    },
  };

  const state = {
    source: "union",
    sourceMask: 7,
    visibleHosts: [],
    expandedHosts: new Set(),
    expandedNodes: new Set(),
    hostElements: new Map(),
    nodeHostCache: new Map(),
    urlCache: new Map(),
    results: [],
    totalMatches: 0,
    page: 0,
    onlyStruck: false,
    resultFilter: "", // live substring filter over the full URL, ANDed with matches
    searchTerms: [],
    matchMode: "partial",
    hideConfirmedNotFound: true,
    marks: {},
    selections: new Set(),
    notes: {},
    paneCollapsed: new Set(),
    hostNameToIndex: null,
    storageAvailable: true,
    activeReviewNodeId: null,
    activeNoteUrl: null,
    noteTimer: null,
    matchNodeIds: new Set(),
    allMatchNodeIds: new Set(), // EVERY match, uncapped — drives highlights & host-match
    pathNodeIds: new Set(),
    pathHostIds: new Set(),
    matchHostIds: new Set(),
    searchTimer: null,
  };

  const elements = {};

  // Server sync. Same-origin JSON API served by server.py. Degrades silently to
  // localStorage-only when there is no server (e.g. the page opened as file://).
  const SYNC = (() => {
    let reachable = false;
    // Independent debounced channels so a note save (private) can never overwrite
    // the shared marks/selections, and vice-versa. Each channel has its own
    // endpoint, pending body builder, timer, and completion callbacks.
    const channels = Object.create(null);
    const enc = encodeURIComponent;
    function stateUrl() {
      return `api/state?institution=${enc(INSTITUTION)}&user=${enc(USER)}`;
    }
    const CHANNEL_URLS = {
      shared: () => `api/shared?institution=${enc(INSTITUTION)}`,
      notes: () => `api/notes?institution=${enc(INSTITUTION)}&user=${enc(USER)}`,
      keywords: () => `api/keywords?institution=${enc(INSTITUTION)}`,
    };
    async function load() {
      try {
        const response = await fetch(stateUrl(), { cache: "no-store" });
        if (!response.ok) {
          return null;
        }
        reachable = true;
        return await response.json();
      } catch (error) {
        return null;
      }
    }
    async function loadKeywords() {
      try {
        const response = await fetch(
          `api/keywords?institution=${enc(INSTITUTION)}`,
          { cache: "no-store" }
        );
        if (!response.ok) {
          return null;
        }
        return await response.json();
      } catch (error) {
        return null;
      }
    }
    async function loadInstitutions() {
      try {
        const response = await fetch("api/institutions", { cache: "no-store" });
        if (!response.ok) {
          return null;
        }
        return await response.json();
      } catch (error) {
        return null;
      }
    }
    async function flushChannel(name, keepalive) {
      const ch = channels[name];
      if (!ch) {
        return;
      }
      ch.timer = null;
      if (!ch.body) {
        return;
      }
      const body = ch.body();
      const callbacks = ch.cbs;
      ch.body = null;
      ch.cbs = [];
      let ok = false;
      try {
        const options = {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        };
        if (keepalive) {
          options.keepalive = true; // best-effort send during page unload
        }
        const response = await fetch(CHANNEL_URLS[name](), options);
        reachable = response.ok;
        ok = response.ok;
      } catch (error) {
        reachable = false;
      }
      for (const cb of callbacks) {
        cb(ok);
      }
    }
    // onDone(ok) fires once this channel's next flush completes (used by the
    // notes editor to show a Saved / not-saved label). Coalesced pushes all fire.
    function push(name, getBody, onDone) {
      if (!reachable) {
        if (onDone) {
          onDone(false); // localStorage only this session
        }
        return;
      }
      const ch = channels[name] || (channels[name] = { timer: null, body: null, cbs: [] });
      ch.body = getBody;
      if (onDone) {
        ch.cbs.push(onDone);
      }
      if (!ch.timer) {
        ch.timer = window.setTimeout(() => flushChannel(name, false), 700);
      }
    }
    function flushAll() {
      // On tab close: fire any pending channel immediately (keepalive) so the
      // last sub-debounce change is not lost.
      for (const name of Object.keys(channels)) {
        const ch = channels[name];
        if (ch && ch.timer) {
          window.clearTimeout(ch.timer);
          flushChannel(name, true);
        }
      }
    }
    return {
      load, loadKeywords, loadInstitutions, flushAll,
      pushShared: (getBody, onDone) => push("shared", getBody, onDone),
      pushNotes: (getBody, onDone) => push("notes", getBody, onDone),
      pushKeywords: (getBody, onDone) => push("keywords", getBody, onDone),
      get reachable() { return reachable; },
    };
  })();

  let lastSharedTerms = null;

  function mountHeaderControls() {
    const badge = document.getElementById("userBadge");
    if (badge) {
      badge.textContent = USER.charAt(0).toUpperCase() + USER.slice(1);
    }
    const select = document.getElementById("institutionSelect");
    if (!select) {
      return;
    }
    const setOptions = (list) => {
      const items = Array.isArray(list) && list.length
        ? list
        : [{ id: INSTITUTION, label: INSTITUTION }];
      select.replaceChildren();
      let hasCurrent = false;
      for (const inst of items) {
        if (!inst || !inst.id) {
          continue;
        }
        const option = document.createElement("option");
        option.value = inst.id;
        option.textContent = inst.label || inst.id;
        if (inst.id === INSTITUTION) {
          option.selected = true;
          hasCurrent = true;
        }
        select.append(option);
      }
      if (!hasCurrent) {
        const option = document.createElement("option");
        option.value = INSTITUTION;
        option.textContent = INSTITUTION;
        option.selected = true;
        select.append(option);
      }
    };
    setOptions(null); // immediate fallback so the current institution shows
    SYNC.loadInstitutions().then((list) => {
      if (list) {
        setOptions(list);
      }
    });
    select.addEventListener("change", () => {
      const id = select.value;
      if (id && id !== INSTITUTION) {
        window.location.href =
          `tree.html?institution=${encodeURIComponent(id)}&user=${encodeURIComponent(USER)}`;
      }
    });
  }

  function startKeywordSync(initialTerms) {
    // Keywords are shared across reviewers. Poll for changes made by the other
    // user and update the box — but never while this reviewer is typing in it.
    lastSharedTerms = typeof initialTerms === "string" ? initialTerms : null;
    window.setInterval(async () => {
      const data = await SYNC.loadKeywords();
      const terms = data && data.search && typeof data.search.terms === "string"
        ? data.search.terms
        : null;
      if (terms === null) {
        return;
      }
      if (lastSharedTerms === null) {
        lastSharedTerms = terms;
        return;
      }
      if (terms !== lastSharedTerms) {
        lastSharedTerms = terms;
        if (document.activeElement !== elements.searchInput
            && elements.searchInput.value !== terms) {
          elements.searchInput.value = terms;
          try {
            window.localStorage.setItem(SEARCH_STORAGE_KEY, JSON.stringify({
              version: 1,
              terms,
              matchMode: elements.matchMode.value,
              termLogic: elements.termLogic.value,
            }));
          } catch (error) {
            /* ignore */
          }
        }
      }
    }, KEYWORD_POLL_MS);
  }

  function formatNumber(value) {
    return new Intl.NumberFormat("en-US").format(value);
  }

  function currentConfig() {
    return sourceConfig[state.source];
  }

  // Auto-strikes (host "no keyword match", cascade "matched descendants all
  // struck") are DERIVED from the current keywords — recomputed on every search.
  // They must never be saved: a saved one goes stale when the data or keywords
  // change (e.g. a host that had 0 paths later gains real pages) and silently
  // hides content — a false negative. So they are stripped at every save/load
  // boundary and only ever live in memory for the current search.
  const AUTO_NOTE_PREFIX = "auto:";
  function isAutoMark(mark) {
    return Boolean(mark && typeof mark.note === "string" && mark.note.startsWith(AUTO_NOTE_PREFIX));
  }
  function manualMarks(marks) {
    const out = {};
    for (const url of Object.keys(marks || {})) {
      if (!isAutoMark(marks[url])) {
        out[url] = marks[url];
      }
    }
    return out;
  }

  function loadReviewMarks() {
    try {
      const saved = window.localStorage.getItem(REVIEW_STORAGE_KEY);
      if (!saved) {
        return;
      }
      const parsed = JSON.parse(saved);
      if (parsed && (parsed.version === 1 || parsed.version === 2) && parsed.marks && typeof parsed.marks === "object") {
        state.marks = manualMarks(parsed.marks);
      }
      if (parsed && parsed.version === 2 && Array.isArray(parsed.selections)) {
        state.selections = new Set(parsed.selections);
      }
      if (parsed && parsed.notes && typeof parsed.notes === "object") {
        state.notes = parsed.notes;
      }
    } catch (error) {
      console.warn("Review marks could not be loaded", error);
      state.storageAvailable = false;
    }
  }

  function writeLocalReview() {
    try {
      window.localStorage.setItem(
        REVIEW_STORAGE_KEY,
        JSON.stringify({
          version: 2,
          marks: manualMarks(state.marks), // never cache derived auto-strikes
          selections: [...state.selections],
          notes: state.notes,
        })
      );
      state.storageAvailable = true;
    } catch (error) {
      console.warn("Review marks could not be saved", error);
      state.storageAvailable = false;
    }
  }

  function persistReviewMarks() {
    writeLocalReview();          // offline cache / fallback (marks+selections+notes)
    SYNC.pushShared(sharedBody); // marks + selections are shared (debounced)
    updateReviewSummary();
  }

  // Shared across reviewers: strike marks + selections. Auto-strikes are derived,
  // never shared — only the reviewers' real (manual) strikes persist.
  function sharedBody() {
    return {
      marks: manualMarks(state.marks),
      selections: [...state.selections],
    };
  }

  // Private to this reviewer: notes.
  function notesBody() {
    return { notes: state.notes };
  }

  // Shared across reviewers: the keyword/search list.
  function keywordsBody() {
    return {
      search: {
        terms: elements.searchInput ? elements.searchInput.value : "",
        matchMode: elements.matchMode ? elements.matchMode.value : "partial",
        termLogic: elements.termLogic ? elements.termLogic.value : "any",
      },
    };
  }

  function reviewStateForNode(nodeId) {
    const exact = state.marks[nodeUrl(nodeId)] || null;
    let branch = null;
    let currentId = nodeId;
    while (currentId !== -1) {
      const candidate = state.marks[nodeUrl(currentId)];
      if (candidate?.scope === "branch") {
        branch = candidate;
        break;
      }
      currentId = window.URL_TREE_DATA.nodes[currentId][NODE_PARENT];
    }
    return {
      exact,
      governing: exact || branch,
      struck: Boolean(exact || branch),
    };
  }

  function reasonLabel(reason) {
    return reason === "offline" ? "Not currently online" : "Not relevant";
  }

  // ------------------------------------------------------------------
  // Selection state (keyed by clean URL so it is stable across data
  // regenerations and portable to the future server-side store).
  // ------------------------------------------------------------------

  function isSelected(nodeId) {
    return state.selections.has(nodeUrl(nodeId));
  }

  function withinSelection(nodeId) {
    // True when this node itself or any ancestor is explicitly selected, so
    // descendants of a selected node can be shaded as part of the selection.
    let currentId = nodeId;
    while (currentId !== -1) {
      if (state.selections.has(nodeUrl(currentId))) {
        return true;
      }
      currentId = window.URL_TREE_DATA.nodes[currentId][NODE_PARENT];
    }
    return false;
  }

  function hasSelectionAtOrBelow(nodeId) {
    // True when this node, or anything in its subtree, is selected. Used to
    // forbid striking a branch that protects a selection.
    const selfUrl = nodeUrl(nodeId);
    const prefix = selfUrl.endsWith("/") ? selfUrl : `${selfUrl}/`;
    for (const url of state.selections) {
      if (url === selfUrl || url.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  }

  function findNodeIdByUrl(url) {
    let host;
    let path;
    try {
      const parsed = new URL(url);
      host = parsed.hostname;
      path = parsed.pathname;
    } catch {
      return null;
    }
    const hostIndex = state.hostNameToIndex.get(host);
    if (hostIndex === undefined) {
      return null;
    }
    let nodeId = window.URL_TREE_DATA.hosts[hostIndex][HOST_ROOT];
    for (const segment of path.split("/").filter(Boolean)) {
      const children = window.URL_TREE_DATA.nodes[nodeId][NODE_CHILDREN];
      let next = null;
      for (const childId of children) {
        if (window.URL_TREE_DATA.nodes[childId][NODE_LABEL] === segment) {
          next = childId;
          break;
        }
      }
      if (next === null) {
        return null;
      }
      nodeId = next;
    }
    return nodeId;
  }

  function nodeVisible(nodeId) {
    const maskIndex = state.hideConfirmedNotFound ? NODE_RETAINED_MASK : NODE_MASK;
    return Boolean(window.URL_TREE_DATA.nodes[nodeId][maskIndex] & state.sourceMask);
  }

  function filteredVariantCount(nodeId) {
    if (
      state.hideConfirmedNotFound &&
      window.URL_TREE_DATA.nodes[nodeId][NODE_CONFIRMED_NOT_FOUND]
    ) {
      return 0;
    }
    return Number(Boolean(
      window.URL_TREE_DATA.nodes[nodeId][NODE_ENDPOINT_MASK] & state.sourceMask
    ));
  }

  function hostIndexForNode(nodeId) {
    if (state.nodeHostCache.has(nodeId)) {
      return state.nodeHostCache.get(nodeId);
    }
    const lineage = [];
    let currentId = nodeId;
    while (window.URL_TREE_DATA.nodes[currentId][NODE_PARENT] !== -1) {
      lineage.push(currentId);
      currentId = window.URL_TREE_DATA.nodes[currentId][NODE_PARENT];
    }
    const hostIndex = state.rootToHost.get(currentId);
    state.nodeHostCache.set(currentId, hostIndex);
    for (const lineageId of lineage) {
      state.nodeHostCache.set(lineageId, hostIndex);
    }
    return hostIndex;
  }

  function nodeUrl(nodeId) {
    if (state.urlCache.has(nodeId)) {
      return state.urlCache.get(nodeId);
    }
    const segments = [];
    let currentId = nodeId;
    while (window.URL_TREE_DATA.nodes[currentId][NODE_PARENT] !== -1) {
      segments.push(window.URL_TREE_DATA.nodes[currentId][NODE_LABEL]);
      currentId = window.URL_TREE_DATA.nodes[currentId][NODE_PARENT];
    }
    const hostIndex = hostIndexForNode(nodeId);
    const hostName = window.URL_TREE_DATA.hosts[hostIndex][HOST_NAME];
    const path = segments.length ? segments.reverse().join("/") : "";
    const url = `https://${hostName}/${path}`;
    state.urlCache.set(nodeId, url);
    return url;
  }

  function visibleChildren(nodeId) {
    return window.URL_TREE_DATA.nodes[nodeId][NODE_CHILDREN].filter(nodeVisible);
  }

  function createChevron() {
    const chevron = document.createElement("span");
    chevron.className = "chevron";
    chevron.textContent = "›";
    chevron.setAttribute("aria-hidden", "true");
    return chevron;
  }

  function renderNode(nodeId) {
    const node = window.URL_TREE_DATA.nodes[nodeId];
    const children = visibleChildren(nodeId);
    const item = document.createElement("li");
    item.className = "tree-node";
    item.id = `node-${nodeId}`;

    const row = document.createElement("div");
    row.className = "node-row";
    row.dataset.nodeId = nodeId;
    if (state.pathNodeIds.has(nodeId)) {
      row.classList.add("is-path-highlight");
    }
    if (state.matchNodeIds.has(nodeId)) {
      row.classList.add("is-match-highlight");
    }

    if (children.length) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "node-toggle";
      toggle.setAttribute("aria-label", `Expand ${node[NODE_LABEL]}`);
      toggle.setAttribute("aria-expanded", "false");
      toggle.append(createChevron());
      toggle.addEventListener("click", () => toggleNode(nodeId));
      row.append(toggle);
    } else {
      const spacer = document.createElement("span");
      spacer.className = "node-spacer";
      row.append(spacer);
    }

    const variantCount = filteredVariantCount(nodeId);
    const link = document.createElement(variantCount ? "a" : "span");
    link.className = "node-link";
    if (variantCount) {
      link.href = nodeUrl(nodeId);
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    } else {
      link.classList.add("node-directory");
    }
    link.textContent = node[NODE_LABEL];
    link.title = nodeUrl(nodeId);
    row.append(link);

    if (variantCount && state.source !== "union") {
      const endpointBadge = document.createElement("span");
      endpointBadge.className = "node-badge";
      endpointBadge.textContent = currentConfig().badge;
      endpointBadge.title = "Clean URL path endpoint";
      row.append(endpointBadge);
    }

    const reviewButton = document.createElement("button");
    reviewButton.type = "button";
    reviewButton.className = "node-review-button";
    reviewButton.addEventListener("click", () => openReviewDialog(nodeId));
    row.append(reviewButton);

    const selectButton = document.createElement("button");
    selectButton.type = "button";
    selectButton.className = "node-select-button";
    selectButton.addEventListener("click", () => toggleSelect(nodeId));
    row.append(selectButton);

    // Single source of truth for the strike/selection presentation, shared with
    // the in-place updater so a full render and an incremental update can never
    // disagree.
    decorateRowReview(row, nodeId);

    item.append(row);
    if (state.expandedNodes.has(nodeId) && children.length) {
      appendNodeChildren(item, nodeId, children);
    }
    return item;
  }

  function decorateRowReview(row, nodeId) {
    const node = window.URL_TREE_DATA.nodes[nodeId];
    const review = reviewStateForNode(nodeId);
    const selected = isSelected(nodeId);
    const selectedDescendant =
      !selected && withinSelection(nodeId) && !review.struck;
    row.classList.toggle("is-review-struck", review.struck);
    row.classList.toggle("is-selected", selected);
    row.classList.toggle("is-selected-descendant", selectedDescendant);
    row.title = review.struck
      ? review.governing.note || reasonLabel(review.governing.reason)
      : "";

    const reviewButton = row.querySelector(":scope > .node-review-button");
    let badge = row.querySelector(":scope > .review-badge");
    if (review.exact) {
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "review-badge";
        row.insertBefore(badge, reviewButton);
      }
      badge.textContent = review.exact.scope === "branch" ? "Branch struck" : "Struck";
      badge.title = reasonLabel(review.exact.reason);
    } else if (badge) {
      badge.remove();
    }
    if (reviewButton) {
      reviewButton.textContent = review.exact ? "Edit mark" : "Strike";
      reviewButton.title = review.exact ? "Edit review mark" : "Strike this node and its children";
      reviewButton.setAttribute(
        "aria-label",
        review.exact ? `Edit review mark for ${node[NODE_LABEL]}` : `Mark ${node[NODE_LABEL]}`
      );
    }
    const selectButton = row.querySelector(":scope > .node-select-button");
    if (selectButton) {
      selectButton.textContent = selected ? "Selected" : "Select";
      selectButton.classList.toggle("is-active", selected);
      selectButton.title = selected
        ? "Remove this path from the selection pane"
        : "Add this path and its non-struck subtree to the selection pane";
    }
  }

  function appendNodeChildren(item, nodeId, children = visibleChildren(nodeId)) {
    let list = item.querySelector(":scope > .node-children");
    if (list) {
      return list;
    }
    list = document.createElement("ul");
    list.className = "node-list node-children";
    renderChildBatch(list, children, 0);
    item.append(list);
    const toggle = item.querySelector(":scope > .node-row > .node-toggle");
    if (toggle) {
      toggle.setAttribute("aria-expanded", "true");
      toggle.setAttribute("aria-label", `Collapse ${window.URL_TREE_DATA.nodes[nodeId][NODE_LABEL]}`);
    }
    return list;
  }

  function renderChildBatch(list, children, start) {
    // Render children in bounded batches so a node with thousands of children
    // (some Chase hosts have 1k-10k) never builds that many DOM rows at once,
    // which is what froze the page. A trailing "show more" row loads the rest.
    const existingMore = list.querySelector(":scope > .node-more");
    if (existingMore) {
      existingMore.remove();
    }
    const end = Math.min(start + CHILD_PAGE, children.length);
    for (let i = start; i < end; i += 1) {
      list.append(renderNode(children[i]));
    }
    if (end < children.length) {
      const remaining = children.length - end;
      const moreItem = document.createElement("li");
      moreItem.className = "node-more";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "node-more-button";
      button.textContent = `Show ${Math.min(CHILD_PAGE, remaining)} more (${formatNumber(remaining)} hidden)`;
      button.addEventListener("click", () => renderChildBatch(list, children, end));
      moreItem.append(button);
      list.append(moreItem);
    }
  }

  function ensureChildRendered(parentId, childId) {
    // Force enough batches of parentId's children to render so childId exists in
    // the DOM (used by reveal, for a match that lives past the first batch).
    const parentItem = document.getElementById(`node-${parentId}`);
    const list = parentItem?.querySelector(":scope > .node-children");
    if (!list) {
      return;
    }
    let guard = 0;
    while (!document.getElementById(`node-${childId}`)) {
      const more = list.querySelector(":scope > .node-more > .node-more-button");
      if (!more || guard > 10000) {
        break;
      }
      more.click();
      guard += 1;
    }
  }

  function toggleNode(nodeId) {
    const item = document.getElementById(`node-${nodeId}`);
    if (!item) {
      return;
    }
    const children = item.querySelector(":scope > .node-children");
    const toggle = item.querySelector(":scope > .node-row > .node-toggle");
    if (children) {
      children.remove();
      state.expandedNodes.delete(nodeId);
      toggle?.setAttribute("aria-expanded", "false");
      toggle?.setAttribute("aria-label", `Expand ${window.URL_TREE_DATA.nodes[nodeId][NODE_LABEL]}`);
    } else {
      state.expandedNodes.add(nodeId);
      appendNodeChildren(item, nodeId);
    }
  }

  function renderHost(hostIndex) {
    const host = window.URL_TREE_DATA.hosts[hostIndex];
    const card = document.createElement("section");
    card.className = "host-card";
    card.id = `host-${hostIndex}`;

    const header = document.createElement("div");
    header.className = "host-header";
    if (state.pathHostIds.has(hostIndex)) {
      header.classList.add("is-path-highlight");
    }
    if (state.matchHostIds.has(hostIndex)) {
      header.classList.add("is-match-highlight");
    }
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "host-toggle";
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-label", `Expand ${host[HOST_NAME]}`);
    toggle.append(createChevron());
    toggle.addEventListener("click", () => toggleHost(hostIndex));

    const rootId = host[HOST_ROOT];
    const rootIsEndpoint = Boolean(filteredVariantCount(rootId));
    const link = document.createElement(rootIsEndpoint ? "a" : "span");
    link.className = "host-link";
    if (rootIsEndpoint) {
      link.href = `https://${host[HOST_NAME]}/`;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
    link.textContent = host[HOST_NAME];

    const count = document.createElement("span");
    count.className = "host-count";
    const countSet = state.hideConfirmedNotFound
      ? host[HOST_RETAINED_COUNTS]
      : host[HOST_COUNTS];
    count.textContent = `${formatNumber(countSet[currentConfig().countIndex])} paths`;

    const hostSelectButton = document.createElement("button");
    hostSelectButton.type = "button";
    hostSelectButton.className = "node-select-button";
    hostSelectButton.addEventListener("click", () => toggleSelect(host[HOST_ROOT]));

    header.append(toggle, link, count, hostSelectButton);
    decorateHeaderReview(header, hostIndex);
    card.append(header);
    state.hostElements.set(hostIndex, card);
    return card;
  }

  function decorateHeaderReview(header, hostIndex) {
    const rootId = window.URL_TREE_DATA.hosts[hostIndex][HOST_ROOT];
    const review = reviewStateForNode(rootId);
    const selected = isSelected(rootId);
    const selectedDescendant =
      !selected && withinSelection(rootId) && !review.struck;
    header.classList.toggle("is-review-struck", review.struck);
    header.classList.toggle("is-selected", selected);
    header.classList.toggle("is-selected-descendant", selectedDescendant);
    header.title = review.struck
      ? review.governing.note || reasonLabel(review.governing.reason)
      : "";
    const selectButton = header.querySelector(":scope > .node-select-button");
    if (selectButton) {
      selectButton.textContent = selected ? "Selected" : "Select";
      selectButton.classList.toggle("is-active", selected);
      selectButton.title = selected
        ? "Remove this host from the selection pane"
        : "Add this host and its non-struck subtree to the selection pane";
    }
  }

  function applyReviewState() {
    // In-place refresh of strike/selection presentation on the currently-rendered
    // rows only — no DOM teardown, so it stays O(visible rows) instead of
    // re-rendering the whole expanded tree on every strike/select.
    for (const [hostIndex, card] of state.hostElements) {
      const header = card.querySelector(":scope > .host-header");
      if (header) {
        decorateHeaderReview(header, hostIndex);
      }
    }
    for (const row of elements.tree.querySelectorAll(".node-row")) {
      decorateRowReview(row, Number(row.dataset.nodeId));
    }
  }

  function expandHost(hostIndex) {
    const card = state.hostElements.get(hostIndex);
    if (!card || card.querySelector(":scope > .host-body")) {
      return;
    }
    const body = document.createElement("div");
    body.className = "host-body";
    const list = document.createElement("ul");
    list.className = "node-list";
    list.append(renderNode(window.URL_TREE_DATA.hosts[hostIndex][HOST_ROOT]));
    body.append(list);
    card.append(body);
    state.expandedHosts.add(hostIndex);
    const toggle = card.querySelector(".host-toggle");
    toggle.setAttribute("aria-expanded", "true");
    toggle.setAttribute("aria-label", `Collapse ${window.URL_TREE_DATA.hosts[hostIndex][HOST_NAME]}`);
  }

  function collapseHost(hostIndex) {
    const card = state.hostElements.get(hostIndex);
    card?.querySelector(":scope > .host-body")?.remove();
    state.expandedHosts.delete(hostIndex);
    const toggle = card?.querySelector(".host-toggle");
    toggle?.setAttribute("aria-expanded", "false");
    toggle?.setAttribute("aria-label", `Expand ${window.URL_TREE_DATA.hosts[hostIndex][HOST_NAME]}`);
  }

  function toggleHost(hostIndex) {
    if (state.expandedHosts.has(hostIndex)) {
      collapseHost(hostIndex);
    } else {
      expandHost(hostIndex);
    }
  }

  function collapseAll() {
    for (const hostIndex of [...state.expandedHosts]) {
      collapseHost(hostIndex);
    }
    state.expandedNodes.clear();
  }

  function clearSearchHighlights() {
    state.matchNodeIds.clear();
    state.pathNodeIds.clear();
    state.pathHostIds.clear();
    state.matchHostIds.clear();
    document.querySelectorAll(".is-match-highlight, .is-path-highlight").forEach((element) => {
      element.classList.remove("is-match-highlight", "is-path-highlight");
    });
  }

  function labelMatchesSearch(label) {
    if (state.matchMode === "exact") {
      return false;
    }
    const comparableLabel = label.toLowerCase();
    return state.searchTerms.some((term) => comparableLabel.includes(term));
  }

  function nodeLineage(nodeId) {
    const lineage = [];
    let currentId = nodeId;
    while (currentId !== -1) {
      lineage.push(currentId);
      currentId = window.URL_TREE_DATA.nodes[currentId][NODE_PARENT];
    }
    return lineage.reverse();
  }

  function buildSearchHighlights() {
    clearSearchHighlights();
    // A result node is a real per-segment match, so it gets the match (rose)
    // highlight; only its ANCESTORS get the path (amber) highlight. Descendants of
    // a match are never highlighted here — they light up only if their own segment
    // matches, in which case they are their own result. Iterate EVERY match (not
    // the capped result list), so highlights and host-match detection — which
    // drives auto host-strikes — never blank out for matches past the cap.
    const uniqueMatches = state.allMatchNodeIds;
    for (const nodeId of uniqueMatches) {
      state.matchNodeIds.add(nodeId);
      const hostIndex = hostIndexForNode(nodeId);
      state.pathHostIds.add(hostIndex);
      for (const lineageId of nodeLineage(nodeId)) {
        if (lineageId !== nodeId) {
          state.pathNodeIds.add(lineageId);
        }
      }
    }
    for (let hostIndex = 0; hostIndex < window.URL_TREE_DATA.hosts.length; hostIndex += 1) {
      if (labelMatchesSearch(window.URL_TREE_DATA.hosts[hostIndex][HOST_NAME])) {
        state.matchHostIds.add(hostIndex);
      }
    }
  }

  function autoExpandSearchMatches() {
    const uniqueMatches = [...state.allMatchNodeIds].slice(0, AUTO_EXPAND_MATCH_LIMIT);
    state.expandedHosts.clear();
    state.expandedNodes.clear();
    for (const nodeId of uniqueMatches) {
      state.expandedHosts.add(hostIndexForNode(nodeId));
      for (const lineageId of nodeLineage(nodeId).slice(0, -1)) {
        if (visibleChildren(lineageId).length) {
          state.expandedNodes.add(lineageId);
        }
      }
    }
  }

  function revealNode(nodeId) {
    const hostIndex = hostIndexForNode(nodeId);
    expandHost(hostIndex);
    const lineage = nodeLineage(nodeId);
    for (let i = 0; i < lineage.length - 1; i += 1) {
      const ancestorId = lineage[i];
      const item = document.getElementById(`node-${ancestorId}`);
      if (item && visibleChildren(ancestorId).length) {
        state.expandedNodes.add(ancestorId);
        appendNodeChildren(item, ancestorId);
        // Render enough batches of this ancestor's children that the next node on
        // the path exists, so reveal still works past the first batch.
        ensureChildRendered(ancestorId, lineage[i + 1]);
      }
    }

    const targetRow = document.querySelector(`#node-${nodeId} > .node-row`);
    targetRow?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function parseTerms() {
    const raw = elements.searchInput.value.trim();
    if (!raw) {
      return [];
    }
    if (elements.matchMode.value === "exact") {
      return raw.split(/\n+/).map((term) => term.trim()).filter(Boolean);
    }
    return raw.split(/[\n,]+/).map((term) => term.trim().toLowerCase()).filter(Boolean);
  }

  function labelMatches(label, terms, logic) {
    // Keyword match against a single path segment (the node's own name), so a
    // match does not leak onto every descendant that merely inherits the segment
    // in its full URL (e.g. .../secure/college-offer).
    const comparable = label.toLowerCase();
    if (logic === "all") {
      return terms.every((term) => comparable.includes(term));
    }
    return terms.some((term) => comparable.includes(term));
  }

  function runSearch(commit = false) {
    const terms = parseTerms();
    if (!terms.length) {
      state.results = [];
      state.totalMatches = 0;
      state.searchTerms = [];
      clearSearchHighlights();
      refreshReviewPresentation();
      elements.resultCount.textContent = "Enter at least one term";
      elements.results.innerHTML = '<div class="empty-state">Add a keyword or full URL to begin.</div>';
      elements.pagination.hidden = true;
      return;
    }

    state.results = [];
    state.totalMatches = 0;
    state.allMatchNodeIds.clear();
    state.page = 0;
    state.onlyStruck = false;
    state.searchTerms = terms;
    state.matchMode = elements.matchMode.value;
    const logic = elements.termLogic.value;
    const exact = state.matchMode === "exact";

    for (let nodeId = 0; nodeId < window.URL_TREE_DATA.nodes.length; nodeId += 1) {
      let matched;
      if (exact) {
        // Exact mode: paste a complete clean URL to locate that one page.
        if (!filteredVariantCount(nodeId)) {
          continue;
        }
        matched = terms.includes(nodeUrl(nodeId));
      } else {
        // Partial mode: a keyword matches a node whose OWN segment contains it.
        if (!nodeVisible(nodeId)) {
          continue;
        }
        matched = labelMatches(window.URL_TREE_DATA.nodes[nodeId][NODE_LABEL], terms, logic);
      }
      if (!matched) {
        continue;
      }
      state.totalMatches += 1;
      state.allMatchNodeIds.add(nodeId); // uncapped: highlights & host-match must see every match
      if (state.results.length < STORED_RESULT_LIMIT) {
        state.results.push({ nodeId, url: nodeUrl(nodeId) });
      }
    }

    buildSearchHighlights();
    // `commit` is set only for an explicit search (the Search button), not the
    // live/debounced search as you type, so hosts are not pruned on a partial term.
    if (commit) {
      strikeHostsWithoutMatches();
    }
    autoExpandSearchMatches();
    refreshReviewPresentation();
    renderResults();
    saveSearchState();
    if (state.totalMatches === 1) {
      revealNode(state.results[0].nodeId);
    }
  }

  const HOST_NOMATCH_NOTE = "auto: no keyword match on host";

  function strikeHostsWithoutMatches() {
    // Strike hosts with no keyword match for the current terms, AND lift the auto
    // "no-match" strike from hosts that DO match now. Re-evaluated every committed
    // search (not cumulative), so a host struck in an earlier search reappears the
    // moment a later search matches it. Manual/cascade strikes are left untouched
    // (only marks carrying HOST_NOMATCH_NOTE are auto-managed here).
    let changed = false;
    for (let hostIndex = 0; hostIndex < window.URL_TREE_DATA.hosts.length; hostIndex += 1) {
      const rootId = window.URL_TREE_DATA.hosts[hostIndex][HOST_ROOT];
      const rootUrl = nodeUrl(rootId);
      const matches = state.pathHostIds.has(hostIndex) || state.matchHostIds.has(hostIndex);
      if (matches) {
        const mark = state.marks[rootUrl];
        if (mark && mark.note === HOST_NOMATCH_NOTE) {
          delete state.marks[rootUrl]; // it matches now → lift the auto strike
          changed = true;
        }
        continue;
      }
      if (hasSelectionAtOrBelow(rootId)) {
        continue;
      }
      changed = strikeBranch(rootId, HOST_NOMATCH_NOTE) || changed;
    }
    if (changed) {
      persistReviewMarks();
    }
  }

  function saveSearchState() {
    try {
      window.localStorage.setItem(SEARCH_STORAGE_KEY, JSON.stringify({
        version: 1,
        terms: elements.searchInput.value,
        matchMode: elements.matchMode.value,
        termLogic: elements.termLogic.value,
      }));
    } catch (error) {
      /* storage unavailable — keywords simply won't persist */
    }
    SYNC.pushKeywords(keywordsBody);
  }

  function loadSearchState() {
    try {
      const saved = window.localStorage.getItem(SEARCH_STORAGE_KEY);
      if (!saved) {
        return null;
      }
      const parsed = JSON.parse(saved);
      if (parsed && parsed.version === 1 && typeof parsed.terms === "string") {
        return parsed;
      }
    } catch (error) {
      /* ignore malformed saved search */
    }
    return null;
  }

  function clearSavedSearchState() {
    try {
      window.localStorage.removeItem(SEARCH_STORAGE_KEY);
    } catch (error) {
      /* ignore */
    }
  }

  function appendHighlightedText(container, text) {
    if (state.matchMode === "exact") {
      const mark = document.createElement("mark");
      mark.textContent = text;
      container.append(mark);
      return;
    }
    const lowerText = text.toLowerCase();
    let cursor = 0;
    while (cursor < text.length) {
      let nextIndex = -1;
      let nextTerm = "";
      for (const term of state.searchTerms) {
        const found = lowerText.indexOf(term, cursor);
        if (found !== -1 && (nextIndex === -1 || found < nextIndex)) {
          nextIndex = found;
          nextTerm = term;
        }
      }
      if (nextIndex === -1) {
        container.append(document.createTextNode(text.slice(cursor)));
        break;
      }
      if (nextIndex > cursor) {
        container.append(document.createTextNode(text.slice(cursor, nextIndex)));
      }
      const mark = document.createElement("mark");
      mark.textContent = text.slice(nextIndex, nextIndex + nextTerm.length);
      container.append(mark);
      cursor = nextIndex + nextTerm.length;
    }
  }

  function nodeMatchedTerms(nodeId) {
    // Which of the CURRENT search terms this node's own segment matches.
    if (!state.searchTerms.length) {
      return [];
    }
    if (state.matchMode === "exact") {
      const url = nodeUrl(nodeId);
      return state.searchTerms.filter((term) => term === url);
    }
    const label = window.URL_TREE_DATA.nodes[nodeId][NODE_LABEL].toLowerCase();
    return state.searchTerms.filter((term) => label.includes(term));
  }

  function governingMarkUrl(nodeId) {
    // URL key of the mark striking this node — its own mark if any, else the
    // nearest ancestor branch mark. Mirrors reviewStateForNode's governing pick.
    const selfUrl = nodeUrl(nodeId);
    if (state.marks[selfUrl]) {
      return selfUrl;
    }
    let currentId = window.URL_TREE_DATA.nodes[nodeId][NODE_PARENT];
    while (currentId !== -1) {
      const url = nodeUrl(currentId);
      const mark = state.marks[url];
      if (mark && mark.scope === "branch") {
        return url;
      }
      currentId = window.URL_TREE_DATA.nodes[currentId][NODE_PARENT];
    }
    return null;
  }

  function newKeywordsForStruckNode(nodeId) {
    // The current terms this STRUCK node matches that were NOT already active
    // when it was struck — i.e. keywords added since. Empty => nothing new to
    // review (it was struck with those keywords already in mind). A legacy mark
    // with no recorded terms counts every matched term as new, so it surfaces
    // once for a one-time review, then quiets after "Mark reviewed"/unstrike.
    const review = reviewStateForNode(nodeId);
    if (!review.struck) {
      return [];
    }
    const matched = nodeMatchedTerms(nodeId);
    if (!matched.length) {
      return [];
    }
    const stamped = review.governing && Array.isArray(review.governing.terms)
      ? review.governing.terms
      : null;
    if (!stamped) {
      return matched;
    }
    return matched.filter((term) => !stamped.includes(term));
  }

  function acknowledgeStruckReview(reviewResults) {
    // "Mark reviewed": record that the current keyword set has now been
    // considered for every surfaced struck path, so they stop re-surfacing until
    // a NEWER keyword matches. Bumps the governing mark's recorded terms (deduped
    // by mark, since a cascade/host mark can govern many surfaced leaves).
    const bumped = new Set();
    let changed = false;
    for (const result of reviewResults) {
      const governingUrl = governingMarkUrl(result.nodeId);
      if (governingUrl === null || bumped.has(governingUrl)) {
        continue;
      }
      bumped.add(governingUrl);
      const mark = state.marks[governingUrl];
      const merged = Array.isArray(mark.terms) ? mark.terms.slice() : [];
      for (const term of state.searchTerms) {
        if (!merged.includes(term)) {
          merged.push(term);
        }
      }
      mark.terms = merged;
      changed = true;
    }
    if (changed) {
      state.onlyStruck = false;
      persistReviewMarks();
      afterReviewChange();
    }
  }

  function renderResults() {
    elements.results.replaceChildren();
    if (!state.totalMatches) {
      elements.resultCount.textContent = "0 matches";
      elements.results.innerHTML = '<div class="empty-state">No clean URL paths matched this search.</div>';
      elements.pagination.hidden = true;
      return;
    }

    // Surface-for-review: struck paths that match a keyword ADDED SINCE they were
    // struck. Nothing is auto-unstruck, and a strike made with a keyword already
    // in mind is NOT re-nagged — only genuinely new keyword hits are flagged.
    // Live substring filter over the full URL, ANDed with the keyword matches
    // (matches host + path, so subdomains and cross-segment substrings both work).
    const filter = state.resultFilter;
    const base = filter
      ? state.results.filter((result) => result.url.toLowerCase().includes(filter))
      : state.results;

    // "To review" = struck paths matching a keyword added since they were struck.
    // Compute it over ALL matches first, then scope to the filter, so we can warn
    // when a filter is hiding some — a filter must never silently mask a would-be
    // review (the no-false-negatives guard).
    const fullReview = state.results.filter((result) => newKeywordsForStruckNode(result.nodeId).length > 0);
    const reviewResults = filter
      ? fullReview.filter((result) => result.url.toLowerCase().includes(filter))
      : fullReview;
    const reviewCount = reviewResults.length;
    const hiddenReview = fullReview.length - reviewCount; // to-review paths outside the filter
    if (state.onlyStruck && reviewCount === 0) {
      state.onlyStruck = false; // nothing left to review → drop back to all matches
    }
    const visible = state.onlyStruck ? reviewResults : base;

    const storedNotice = state.totalMatches > state.results.length
      ? ` · first ${formatNumber(state.results.length)} available`
      : "";
    let reviewNotice = "";
    if (reviewCount) {
      reviewNotice = ` · ${formatNumber(reviewCount)} to review`;
      if (filter && hiddenReview > 0) {
        reviewNotice += ` (+${formatNumber(hiddenReview)} outside filter)`;
      }
    } else if (filter && hiddenReview > 0) {
      // The filter hides EVERY to-review path — the dangerous case: still flag it.
      reviewNotice = ` · ${formatNumber(hiddenReview)} to review outside this filter`;
    }
    elements.resultCount.textContent = filter
      ? `${formatNumber(base.length)} of ${formatNumber(state.totalMatches)} matches contain “${filter}”${storedNotice}${reviewNotice}`
      : `${formatNumber(state.totalMatches)} matches${storedNotice}${reviewNotice}`;

    if (filter && base.length === 0) {
      elements.results.innerHTML =
        `<div class="empty-state">None of the available matches contain “${filter}”.</div>`;
      elements.pagination.hidden = true;
      return;
    }

    if (reviewCount) {
      const newTerms = new Set();
      for (const result of reviewResults) {
        for (const term of newKeywordsForStruckNode(result.nodeId)) {
          newTerms.add(term);
        }
      }
      const termList = [...newTerms];
      const keywordPhrase = termList.length && termList.length <= 4
        ? `: ${termList.join(", ")}`
        : "";
      const banner = document.createElement("div");
      banner.className = "struck-review-banner";
      const text = document.createElement("span");
      text.textContent = state.onlyStruck
        ? `Showing ${formatNumber(reviewCount)} struck path${reviewCount === 1 ? "" : "s"} matching newly added keyword${keywordPhrase} — unstrike anything relevant.`
        : `${formatNumber(reviewCount)} struck path${reviewCount === 1 ? "" : "s"} match a keyword added since they were struck${keywordPhrase}.`;
      const buttons = document.createElement("span");
      buttons.className = "struck-review-buttons";
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "struck-review-toggle";
      toggle.textContent = state.onlyStruck ? "Show all matches" : "Review struck";
      toggle.addEventListener("click", () => {
        state.onlyStruck = !state.onlyStruck;
        state.page = 0;
        renderResults();
      });
      const ack = document.createElement("button");
      ack.type = "button";
      ack.className = "struck-review-ack";
      ack.textContent = "Mark reviewed";
      ack.title = "Keep these struck and stop flagging them for the current keywords";
      ack.addEventListener("click", () => acknowledgeStruckReview(reviewResults));
      buttons.append(toggle, ack);
      banner.append(text, buttons);
      elements.results.append(banner);
    }

    const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
    if (state.page >= pages) {
      state.page = pages - 1; // filter shrank the list past the current page
    }
    const start = state.page * PAGE_SIZE;
    const end = Math.min(start + PAGE_SIZE, visible.length);
    for (const result of visible.slice(start, end)) {
      const card = document.createElement("article");
      card.className = "result-card";
      const review = reviewStateForNode(result.nodeId);
      if (review.struck) {
        card.classList.add("is-review-struck");
        card.title = review.governing.note || reasonLabel(review.governing.reason);
        if (newKeywordsForStruckNode(result.nodeId).length > 0) {
          card.classList.add("needs-review"); // matches a keyword added since strike
        }
      }
      const url = document.createElement("div");
      url.className = "result-url";
      appendHighlightedText(url, result.url);
      const actions = document.createElement("div");
      actions.className = "result-actions";
      if (review.struck) {
        const reviewStatus = document.createElement("span");
        reviewStatus.className = "result-review-status";
        reviewStatus.textContent = review.governing.note || reasonLabel(review.governing.reason);
        actions.append(reviewStatus);
        const unstrike = document.createElement("button");
        unstrike.type = "button";
        unstrike.className = "result-unstrike";
        unstrike.textContent = "Unstrike";
        unstrike.addEventListener("click", () => {
          unstrikeGoverningMark(result.nodeId);
          revealNode(result.nodeId);
        });
        actions.append(unstrike);
      }
      const reveal = document.createElement("button");
      reveal.type = "button";
      reveal.textContent = "Reveal";
      reveal.addEventListener("click", () => revealNode(result.nodeId));
      const open = document.createElement("a");
      open.href = result.url;
      open.target = "_blank";
      open.rel = "noopener noreferrer";
      open.textContent = "Open";
      actions.append(reveal, open);
      card.append(url, actions);
      elements.results.append(card);
    }

    elements.pagination.hidden = pages <= 1;
    elements.pageStatus.textContent = `Page ${state.page + 1} of ${pages}`;
    elements.previousPage.disabled = state.page === 0;
    elements.nextPage.disabled = state.page >= pages - 1;
  }

  function unstrikeGoverningMark(nodeId) {
    // "I reviewed this struck-but-matching path, keep it." Free the node by
    // removing EVERY branch mark along its spine to the root — not just the
    // nearest one. A single leaf strike can trigger a cascade strike on its
    // ancestors (up to the host), so stopping at the first mark would leave the
    // node struck by a higher one. This mirrors carveOutStrikes' spine clear.
    let currentId = nodeId;
    while (currentId !== -1) {
      const mark = state.marks[nodeUrl(currentId)];
      if (mark && mark.scope === "branch") {
        delete state.marks[nodeUrl(currentId)];
      }
      currentId = window.URL_TREE_DATA.nodes[currentId][NODE_PARENT];
    }
    persistReviewMarks();
    afterReviewChange();
  }

  function clearSearch() {
    elements.searchInput.value = "";
    state.results = [];
    state.totalMatches = 0;
    state.allMatchNodeIds.clear();
    state.searchTerms = [];
    state.page = 0;
    state.onlyStruck = false;
    state.resultFilter = "";
    if (elements.resultFilter) {
      elements.resultFilter.value = "";
      elements.resultFilterClear.hidden = true;
    }
    clearSearchHighlights();
    elements.resultCount.textContent = "No search yet";
    elements.results.innerHTML = '<div class="empty-state">Search results will appear here.</div>';
    elements.pagination.hidden = true;
  }

  function updateSearchMode() {
    const exact = elements.matchMode.value === "exact";
    elements.termLogic.disabled = exact;
    elements.termLogicLabel.style.opacity = exact ? "0.5" : "1";
    elements.searchHint.textContent = exact
      ? "Full match mode accepts one complete URL per line."
      : "Partial mode accepts comma- or line-separated terms.";
    elements.searchInput.placeholder = exact
      ? "https://www.example.com/clean/path"
      : "mortgage, calculator\nsmall business";
  }

  function mountHeaderMetrics() {
    const brand = document.querySelector(".brand");
    if (!brand) {
      return;
    }
    const metrics = document.createElement("div");
    metrics.className = "header-metrics";
    metrics.innerHTML = `
      <div class="header-metric"><strong id="headerPaths">–</strong><span>Total paths</span></div>
      <div class="header-metric"><strong id="headerHosts">–</strong><span>Total hosts</span></div>
      <div class="header-metric"><strong id="headerSelected">–</strong><span>Selected URLs</span></div>`;
    brand.replaceWith(metrics);
    elements.headerPaths = metrics.querySelector("#headerPaths");
    elements.headerHosts = metrics.querySelector("#headerHosts");
    elements.headerSelected = metrics.querySelector("#headerSelected");
  }

  function renderHeaderMetrics() {
    if (!elements.headerPaths) {
      return;
    }
    const config = currentConfig();
    let urlCount = 0;
    for (const hostIndex of state.visibleHosts) {
      const host = window.URL_TREE_DATA.hosts[hostIndex];
      const countSet = state.hideConfirmedNotFound
        ? host[HOST_RETAINED_COUNTS]
        : host[HOST_COUNTS];
      urlCount += countSet[config.countIndex];
    }
    elements.headerPaths.textContent = formatNumber(urlCount);
    elements.headerHosts.textContent = formatNumber(state.visibleHosts.length);
    elements.headerSelected.textContent = formatNumber(collectSelectionEndpoints().length);
  }

  function rebuildTree() {
    collapseAll();
    state.hostElements.clear();
    state.visibleHosts = window.URL_TREE_DATA.hosts
      .map((host, index) => ({ host, index }))
      .filter(({ host }) => nodeVisible(host[HOST_ROOT]))
      .map(({ index }) => index);
    elements.tree.replaceChildren();
    for (const hostIndex of state.visibleHosts) {
      elements.tree.append(renderHost(hostIndex));
    }
    clearSearch();
    renderSelectionPane();
    renderHeaderMetrics();
  }

  function refreshReviewPresentation() {
    elements.tree.replaceChildren();
    state.hostElements.clear();
    for (const hostIndex of state.visibleHosts) {
      elements.tree.append(renderHost(hostIndex));
      if (state.expandedHosts.has(hostIndex)) {
        expandHost(hostIndex);
      }
    }
    if (state.totalMatches) {
      renderResults();
    }
    updateReviewSummary();
  }

  function updateReviewSummary() {
    if (!elements.reviewSummary) {
      return;
    }
    const marks = Object.values(state.marks);
    const branchCount = marks.filter((mark) => mark.scope === "branch").length;
    elements.reviewSummary.textContent = `${formatNumber(marks.length)} saved mark${marks.length === 1 ? "" : "s"} · ${formatNumber(branchCount)} branch${branchCount === 1 ? "" : "es"}`;
    elements.reviewStorageStatus.textContent = state.storageAvailable
      ? "Saved in this browser. Export a backup to transfer or preserve marks."
      : "Browser storage is unavailable. Export after each change to preserve marks.";
    elements.clearReviewMarks.disabled = marks.length === 0;
    elements.exportReviewMarks.disabled = marks.length === 0;
  }

  function openReviewDialog(nodeId) {
    state.activeReviewNodeId = nodeId;
    const url = nodeUrl(nodeId);
    const mark = state.marks[url];
    elements.reviewUrl.textContent = url;
    elements.reviewScope.value = mark?.scope || "branch";
    elements.reviewReason.value = mark?.reason || "irrelevant";
    elements.reviewNote.value = mark?.note || "";
    elements.removeReviewMark.hidden = !mark;
    elements.reviewDialog.showModal();
  }

  function closeReviewDialog() {
    state.activeReviewNodeId = null;
    elements.reviewDialog.close();
  }

  function saveActiveReviewMark() {
    if (state.activeReviewNodeId === null) {
      return;
    }
    const nodeId = state.activeReviewNodeId;
    // A selection protects its whole ancestor chain: striking a branch that
    // contains a selected path is not allowed.
    if (hasSelectionAtOrBelow(nodeId)) {
      window.alert(
        "This branch contains a selected path. Remove the selection before striking it."
      );
      return;
    }
    const url = nodeUrl(nodeId);
    state.marks[url] = {
      scope: elements.reviewScope.value,
      reason: elements.reviewReason.value,
      note: elements.reviewNote.value.trim(),
      terms: [...state.searchTerms], // keyword set considered when struck
      updatedAt: new Date().toISOString(),
    };
    autoStrikeUpFrom(nodeId);
    persistReviewMarks();
    closeReviewDialog();
    afterReviewChange();
  }

  function removeActiveReviewMark() {
    if (state.activeReviewNodeId === null) {
      return;
    }
    delete state.marks[nodeUrl(state.activeReviewNodeId)];
    persistReviewMarks();
    closeReviewDialog();
    afterReviewChange();
  }

  function afterReviewChange() {
    applyReviewState();
    if (state.totalMatches) {
      renderResults();
    }
    updateReviewSummary();
    renderSelectionPane();
    renderHeaderMetrics();
  }

  function carveOutStrikes(nodeId) {
    // Selecting a node overrides any strike governing it. Strikes are inherited
    // branch marks, so removing every strike mark along the spine from this node
    // up to the root frees the node — and, because the governing ancestor mark is
    // deleted, its parent and all siblings become live too (the chosen carve-out).
    if (!reviewStateForNode(nodeId).struck) {
      return;
    }
    let currentId = nodeId;
    while (currentId !== -1) {
      delete state.marks[nodeUrl(currentId)];
      currentId = window.URL_TREE_DATA.nodes[currentId][NODE_PARENT];
    }
  }

  function toggleSelect(nodeId) {
    const url = nodeUrl(nodeId);
    if (state.selections.has(url)) {
      state.selections.delete(url);
    } else {
      carveOutStrikes(nodeId);
      state.selections.add(url);
    }
    persistReviewMarks();
    afterReviewChange();
  }

  function strikeBranch(nodeId, note) {
    const url = nodeUrl(nodeId);
    const existing = state.marks[url];
    if (existing && existing.scope === "branch") {
      return false;
    }
    state.marks[url] = {
      scope: "branch",
      reason: "irrelevant",
      note: note || "",
      terms: [...state.searchTerms], // keyword set considered when struck
      updatedAt: new Date().toISOString(),
    };
    return true;
  }

  function autoStrikeUpFrom(struckNodeId) {
    // After striking a node, walk up its ancestors and strike each one whose
    // matched DESCENDANTS are all struck — i.e. no live (non-struck) keyword match
    // remains strictly below it. A parent that matches only through its own URL
    // (e.g. every path under a host whose NAME contains the term) does not stop
    // the cascade; only a live match beneath the parent, a selection, or the host
    // root does. This is the "cascade when matched children all struck" behaviour.
    if (!state.results.length) {
      return;
    }
    // Re-check strike state live (not a pre-loop snapshot): an intermediate
    // matched ancestor struck DURING this cascade must stop counting as a live
    // match, or the cascade halts one level too low.
    const hasLiveMatchBelow = (nodeId) => {
      const selfUrl = nodeUrl(nodeId);
      const prefix = selfUrl.endsWith("/") ? selfUrl : `${selfUrl}/`;
      return state.results.some((result) =>
        result.url !== selfUrl
        && result.url.startsWith(prefix)
        && !reviewStateForNode(result.nodeId).struck
      );
    };
    let changed = false;
    let currentId = window.URL_TREE_DATA.nodes[struckNodeId][NODE_PARENT];
    while (currentId !== -1) {
      if (hasSelectionAtOrBelow(currentId) || hasLiveMatchBelow(currentId)) {
        break;
      }
      changed = strikeBranch(currentId, "auto: matched descendants all struck") || changed;
      currentId = window.URL_TREE_DATA.nodes[currentId][NODE_PARENT];
    }
    if (changed) {
      persistReviewMarks();
    }
  }

  function exportReviewMarks() {
    const payload = {
      version: 2,
      exportedAt: new Date().toISOString(),
      marks: state.marks,
      selections: [...state.selections],
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = "chase-url-tree-review-marks.json";
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 0);
  }

  function urlHostInDataset(url) {
    // Accept a clean https URL whose host belongs to the currently-loaded
    // institution's tree. Institution-agnostic, so import works for any dataset.
    try {
      const parsed = new URL(url);
      return Boolean(
        parsed.protocol === "https:" &&
        !parsed.search &&
        !parsed.hash &&
        state.hostNameToIndex && state.hostNameToIndex.has(parsed.hostname)
      );
    } catch {
      return false;
    }
  }

  function validImportedMark(url, mark) {
    return Boolean(
      urlHostInDataset(url) &&
      mark &&
      ["node", "branch"].includes(mark.scope) &&
      ["irrelevant", "offline"].includes(mark.reason)
    );
  }

  function validSelectionUrl(url) {
    return urlHostInDataset(url);
  }

  async function importReviewMarks(file) {
    const parsed = JSON.parse(await file.text());
    if (!parsed || (parsed.version !== 1 && parsed.version !== 2) || !parsed.marks || typeof parsed.marks !== "object") {
      throw new Error("Unsupported review mark file");
    }
    const imported = {};
    for (const [url, mark] of Object.entries(parsed.marks)) {
      if (validImportedMark(url, mark)) {
        imported[url] = {
          scope: mark.scope,
          reason: mark.reason,
          note: typeof mark.note === "string" ? mark.note : "",
          updatedAt: typeof mark.updatedAt === "string" ? mark.updatedAt : "",
        };
      }
    }
    state.marks = { ...state.marks, ...imported };
    if (parsed.version === 2 && Array.isArray(parsed.selections)) {
      for (const url of parsed.selections) {
        if (validSelectionUrl(url)) {
          state.selections.add(url);
        }
      }
    }
    persistReviewMarks();
    afterReviewChange();
  }

  function renderReviewTools() {
    const panel = document.createElement("section");
    panel.className = "review-tools";
    panel.innerHTML = `
      <div class="review-tools-heading">
        <strong>Backup — marks &amp; selections</strong>
        <span id="reviewSummary"></span>
      </div>
      <p id="reviewStorageStatus"></p>
      <div class="review-tool-actions">
        <button type="button" id="exportReviewMarks">Export</button>
        <button type="button" id="importReviewMarks">Import</button>
        <button type="button" id="clearReviewMarks">Clear all</button>
        <input type="file" id="reviewImportFile" accept="application/json,.json" hidden>
      </div>`;
    if (elements.selectionTools) {
      elements.selectionTools.append(panel);
    } else {
      elements.searchForm.before(panel);
    }
    elements.reviewSummary = panel.querySelector("#reviewSummary");
    elements.reviewStorageStatus = panel.querySelector("#reviewStorageStatus");
    elements.exportReviewMarks = panel.querySelector("#exportReviewMarks");
    elements.importReviewMarks = panel.querySelector("#importReviewMarks");
    elements.clearReviewMarks = panel.querySelector("#clearReviewMarks");
    elements.reviewImportFile = panel.querySelector("#reviewImportFile");

    const dialog = document.createElement("dialog");
    dialog.className = "review-dialog";
    dialog.innerHTML = `
      <form method="dialog" class="review-dialog-form">
        <div class="review-dialog-heading">
          <div><span>Manual review</span><h2>Strike this branch</h2></div>
          <button type="button" class="dialog-close" aria-label="Close">×</button>
        </div>
        <p class="review-url" id="reviewUrl"></p>
        <label>Scope
          <select id="reviewScope">
            <option value="branch">This node and every child below it</option>
          </select>
        </label>
        <label>Reason
          <select id="reviewReason">
            <option value="irrelevant">Not relevant to analyze</option>
            <option value="offline">Not currently online</option>
          </select>
        </label>
        <label>Optional note
          <textarea id="reviewNote" rows="3" maxlength="500" placeholder="Why this was excluded"></textarea>
        </label>
        <div class="review-dialog-actions">
          <button type="button" class="remove-mark" id="removeReviewMark">Remove mark</button>
          <span></span>
          <button type="button" class="quiet-button dialog-cancel">Cancel</button>
          <button type="submit" class="primary-button">Save mark</button>
        </div>
      </form>`;
    document.body.append(dialog);
    elements.reviewDialog = dialog;
    elements.reviewUrl = dialog.querySelector("#reviewUrl");
    elements.reviewScope = dialog.querySelector("#reviewScope");
    elements.reviewReason = dialog.querySelector("#reviewReason");
    elements.reviewNote = dialog.querySelector("#reviewNote");
    elements.removeReviewMark = dialog.querySelector("#removeReviewMark");

    dialog.querySelector("form").addEventListener("submit", (event) => {
      event.preventDefault();
      saveActiveReviewMark();
    });
    dialog.querySelector(".dialog-close").addEventListener("click", closeReviewDialog);
    dialog.querySelector(".dialog-cancel").addEventListener("click", closeReviewDialog);
    elements.removeReviewMark.addEventListener("click", removeActiveReviewMark);
    elements.exportReviewMarks.addEventListener("click", exportReviewMarks);
    elements.importReviewMarks.addEventListener("click", () => elements.reviewImportFile.click());
    elements.reviewImportFile.addEventListener("change", async () => {
      const [file] = elements.reviewImportFile.files;
      if (!file) {
        return;
      }
      try {
        await importReviewMarks(file);
      } catch (error) {
        window.alert(`Review marks could not be imported: ${error.message}`);
      } finally {
        elements.reviewImportFile.value = "";
      }
    });
    elements.clearReviewMarks.addEventListener("click", () => {
      if (window.confirm("Clear all saved review marks?")) {
        state.marks = {};
        persistReviewMarks();
        afterReviewChange();
      }
    });
    updateReviewSummary();
  }

  // ------------------------------------------------------------------
  // Selection pane
  // ------------------------------------------------------------------

  function paneVisibleChildren(nodeId) {
    return window.URL_TREE_DATA.nodes[nodeId][NODE_CHILDREN].filter(
      (childId) => nodeVisible(childId) && !reviewStateForNode(childId).struck
    );
  }

  function nodeHasNote(url) {
    return Boolean(state.notes[url] && state.notes[url].trim());
  }

  function collectSelectionInclude() {
    // Nodes to draw in the pane. A node is "content" if it is under a selection,
    // visible, and NOT struck — OR it is struck but this reviewer has pinned it
    // with a note. Remove strikes a node, so a struck-without-note node vanishes
    // (its whole subtree collapses with it); a note keeps its node on screen so
    // the note is never lost. Every content node then contributes its ancestor
    // chain, so the host → …/… hierarchy stays intact and shared ancestors merge
    // into one real tree per host. A selection whose subtree is entirely removed
    // (no content, no notes) contributes nothing and disappears.
    const content = new Set();
    for (const selUrl of state.selections) {
      const rootId = findNodeIdByUrl(selUrl);
      if (rootId === null) {
        continue;
      }
      const stack = [rootId];
      while (stack.length) {
        const nodeId = stack.pop();
        if (!nodeVisible(nodeId)) {
          continue;
        }
        const struck = reviewStateForNode(nodeId).struck;
        if (!struck || nodeHasNote(nodeUrl(nodeId))) {
          content.add(nodeId);
        }
        // Keep walking through a struck directory: a noted descendant still needs
        // to surface (and re-adds the struck path above it via its ancestors).
        for (const childId of window.URL_TREE_DATA.nodes[nodeId][NODE_CHILDREN]) {
          stack.push(childId);
        }
      }
    }
    const include = new Set();
    for (const nodeId of content) {
      let ancestor = nodeId;
      while (ancestor !== -1 && !include.has(ancestor)) {
        include.add(ancestor);
        ancestor = window.URL_TREE_DATA.nodes[ancestor][NODE_PARENT];
      }
    }
    return include;
  }

  function renderPaneTreeNode(nodeId, include) {
    const node = window.URL_TREE_DATA.nodes[nodeId];
    const isHostRoot = node[NODE_PARENT] === -1;
    const item = document.createElement("li");
    item.className = "selection-node";
    const row = document.createElement("div");
    row.className = "selection-node-row";
    const children = node[NODE_CHILDREN].filter((childId) => include.has(childId));
    const isEndpoint = !isHostRoot && Boolean(filteredVariantCount(nodeId));
    const collapsed = state.paneCollapsed.has(nodeId);
    const struck = reviewStateForNode(nodeId).struck;
    if (struck) {
      row.classList.add("is-review-struck");
    }

    if (children.length) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "pane-toggle";
      toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
      toggle.setAttribute("aria-label", collapsed ? "Expand" : "Collapse");
      toggle.append(createChevron());
      toggle.addEventListener("click", () => {
        if (state.paneCollapsed.has(nodeId)) {
          state.paneCollapsed.delete(nodeId);
        } else {
          state.paneCollapsed.add(nodeId);
        }
        renderSelectionPane();
      });
      row.append(toggle);
    } else {
      const spacer = document.createElement("span");
      spacer.className = "pane-spacer";
      row.append(spacer);
    }

    const hostName = window.URL_TREE_DATA.hosts[hostIndexForNode(nodeId)][HOST_NAME];
    const fullLabel = isHostRoot ? hostName : node[NODE_LABEL];
    const label = document.createElement(isEndpoint ? "a" : "span");
    label.className = "selection-label";
    // Cap the visible segment to 20 chars so wide names don't stack vertically;
    // the full path is always on hover.
    label.textContent = fullLabel.length > 20 ? `${fullLabel.slice(0, 19)}…` : fullLabel;
    label.title = nodeUrl(nodeId);
    if (isHostRoot) {
      label.classList.add("is-host");
    }
    if (isEndpoint) {
      label.href = nodeUrl(nodeId);
      label.target = "_blank";
      label.rel = "noopener noreferrer";
    } else {
      label.classList.add("is-directory");
    }
    row.append(label);

    if (!isHostRoot) {
      // Notes on every node (directories too), not just leaves.
      const url = nodeUrl(nodeId);
      const notesButton = document.createElement("button");
      notesButton.type = "button";
      notesButton.className = "pane-notes-button";
      const hasNote = Boolean(state.notes[url] && state.notes[url].trim());
      if (hasNote) {
        notesButton.classList.add("has-note");
      }
      notesButton.textContent = hasNote ? "Notes •" : "Notes";
      notesButton.title = hasNote ? "Edit your note" : "Add a note";
      notesButton.addEventListener("click", () => openNotesPanel(nodeId));
      row.append(notesButton);

      // Remove drops it (and its subtree) from the pane. It only stays visible —
      // struck, with a Restore button — when it carries a note, so notes survive.
      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = struck ? "pane-restore-button" : "pane-remove-button";
      removeButton.textContent = struck ? "Restore" : "Remove";
      removeButton.title = struck
        ? "Bring this back (unstrike)"
        : (hasNote
            ? "Remove from the selection — kept here struck because it has a note"
            : "Remove from the selection (and everything under it)");
      removeButton.addEventListener("click", () => togglePaneStrike(nodeId));
      row.append(removeButton);
    }

    item.append(row);
    if (children.length && !collapsed) {
      const list = document.createElement("ul");
      list.className = "selection-node-list";
      for (const childId of children) {
        list.append(renderPaneTreeNode(childId, include));
      }
      item.append(list);
    }
    return item;
  }

  function togglePaneStrike(nodeId) {
    // Pane-only toggle: Remove strikes the node (it stays visible, struck, and
    // keeps its note); clicking again restores it. Unstrike removes the governing
    // branch mark — the node's own, or the nearest struck ancestor's.
    if (reviewStateForNode(nodeId).struck) {
      let currentId = nodeId;
      while (currentId !== -1) {
        const mark = state.marks[nodeUrl(currentId)];
        if (mark && mark.scope === "branch") {
          delete state.marks[nodeUrl(currentId)];
          break;
        }
        currentId = window.URL_TREE_DATA.nodes[currentId][NODE_PARENT];
      }
    } else {
      strikeBranch(nodeId, "struck in selection pane");
    }
    persistReviewMarks();
    afterReviewChange();
  }

  function collectSelectionEndpoints() {
    // Every non-struck endpoint reachable under a selected node, de-duplicated
    // across overlapping selections. This is the exportable working set.
    const seen = new Set();
    const urls = [];
    for (const selUrl of state.selections) {
      const rootId = findNodeIdByUrl(selUrl);
      if (rootId === null) {
        continue;
      }
      const stack = [rootId];
      while (stack.length) {
        const nodeId = stack.pop();
        if (reviewStateForNode(nodeId).struck || !nodeVisible(nodeId)) {
          continue;
        }
        if (filteredVariantCount(nodeId) && !seen.has(nodeId)) {
          seen.add(nodeId);
          urls.push(nodeUrl(nodeId));
        }
        for (const childId of window.URL_TREE_DATA.nodes[nodeId][NODE_CHILDREN]) {
          stack.push(childId);
        }
      }
    }
    return urls;
  }

  function flashCopyButton(button, ok) {
    button.textContent = ok ? "Copied" : "Copy failed";
    window.setTimeout(() => {
      button.textContent = "Copy URLs";
    }, 1400);
  }

  function copySelectionUrls(button) {
    const urls = collectSelectionEndpoints();
    if (!urls.length) {
      return;
    }
    const text = urls.join("\n");
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(
        () => flashCopyButton(button, true),
        () => flashCopyButton(button, false)
      );
    } else {
      flashCopyButton(button, false);
    }
  }

  function renderSelectionPane() {
    if (!elements.selectionBody) {
      return;
    }
    const endpoints = collectSelectionEndpoints();
    elements.selectionCount.textContent = `${formatNumber(endpoints.length)} URL${endpoints.length === 1 ? "" : "s"}`;
    elements.selectionBody.replaceChildren();
    if (!state.selections.size) {
      elements.selectionBody.innerHTML =
        '<div class="empty-state">Select a node in the tree to add its paths here.</div>';
      return;
    }
    const include = collectSelectionInclude();
    if (!include.size) {
      elements.selectionBody.innerHTML =
        '<div class="empty-state">Every selected path has been removed. Unstrike one in the tree, or select again.</div>';
      return;
    }
    const hostIndices = new Set();
    for (const nodeId of include) {
      hostIndices.add(hostIndexForNode(nodeId));
    }
    const sortedHosts = [...hostIndices].sort((a, b) =>
      window.URL_TREE_DATA.hosts[a][HOST_NAME].localeCompare(window.URL_TREE_DATA.hosts[b][HOST_NAME])
    );
    const list = document.createElement("ul");
    list.className = "selection-node-list selection-root-list";
    for (const hostIndex of sortedHosts) {
      list.append(renderPaneTreeNode(window.URL_TREE_DATA.hosts[hostIndex][HOST_ROOT], include));
    }
    elements.selectionBody.append(list);
  }

  function mountSelectionPane() {
    const shell = document.querySelector(".app-shell");
    if (!shell) {
      return;
    }
    const pane = document.createElement("aside");
    pane.className = "selection-pane";
    pane.setAttribute("aria-label", "Selected URL paths");
    pane.innerHTML = `
      <div class="selection-header">
        <div>
          <div class="eyebrow">Selection</div>
          <h2>Chosen paths</h2>
        </div>
        <span id="selectionCount">0 URLs</span>
      </div>
      <p class="selection-note">Expand a branch to manage it. On each URL: <strong>Notes</strong> for a private note, <strong>Remove</strong> to drop it and everything under it. A URL with a note stays visible (struck) so the note is never lost.</p>
      <div class="selection-actions">
        <button type="button" id="copySelection" class="quiet-button">Copy URLs</button>
      </div>
      <div id="selectionBody" class="selection-body"></div>
      <div id="selectionTools" class="selection-tools"></div>`;
    shell.append(pane);
    shell.classList.add("has-selection-pane");
    elements.selectionPane = pane;
    elements.selectionBody = pane.querySelector("#selectionBody");
    elements.selectionCount = pane.querySelector("#selectionCount");
    elements.selectionTools = pane.querySelector("#selectionTools");
    const copyButton = pane.querySelector("#copySelection");
    copyButton.addEventListener("click", () => copySelectionUrls(copyButton));
  }

  // ------------------------------------------------------------------
  // Notes panel — per-user, per-URL; slides in over the search pane.
  // ------------------------------------------------------------------

  function mountNotesPanel() {
    const panel = document.createElement("aside");
    panel.className = "notes-panel";
    panel.setAttribute("aria-label", "URL note");
    panel.innerHTML = `
      <div class="notes-head">
        <div class="eyebrow">Note · ${USER}</div>
        <button type="button" class="notes-close" aria-label="Close">×</button>
      </div>
      <p class="notes-url" id="notesUrl"></p>
      <textarea id="notesText" class="notes-text" spellcheck="true" placeholder="Type your note…  Enter = new line,  Shift+Enter = save."></textarea>
      <div class="notes-foot">
        <span class="notes-status" id="notesStatus"></span>
        <span class="notes-hint">Shift+Enter saves · also autosaves</span>
      </div>`;
    document.body.append(panel);
    elements.notesPanel = panel;
    elements.notesUrl = panel.querySelector("#notesUrl");
    elements.notesText = panel.querySelector("#notesText");
    elements.notesStatus = panel.querySelector("#notesStatus");
    panel.querySelector(".notes-close").addEventListener("click", closeNotesPanel);
    elements.notesText.addEventListener("input", () => {
      setNoteStatus("unsaved");
      window.clearTimeout(state.noteTimer);
      state.noteTimer = window.setTimeout(saveActiveNote, 1200);
    });
    elements.notesText.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && event.shiftKey) {
        event.preventDefault(); // Enter alone makes a new line; Shift+Enter saves.
        window.clearTimeout(state.noteTimer);
        saveActiveNote();
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.activeNoteUrl !== null) {
        closeNotesPanel();
      }
    });
  }

  function setNoteStatus(kind) {
    if (!elements.notesStatus) {
      return;
    }
    const map = {
      saved: ["Saved", "is-saved"],
      saving: ["Saving…", "is-saving"],
      unsaved: ["Unsaved changes", "is-unsaved"],
      offline: ["Saved on this device", "is-offline"],
    };
    const [text, cls] = map[kind] || ["", ""];
    elements.notesStatus.textContent = text;
    elements.notesStatus.className = `notes-status ${cls}`;
  }

  function openNotesPanel(nodeId) {
    const url = nodeUrl(nodeId);
    if (state.activeNoteUrl !== null && state.activeNoteUrl !== url) {
      window.clearTimeout(state.noteTimer);
      saveActiveNote(); // flush the previously-open note before switching
    }
    state.activeNoteUrl = url;
    elements.notesUrl.textContent = url;
    elements.notesText.value = state.notes[url] || "";
    setNoteStatus(state.notes[url] ? "saved" : "none");
    elements.notesPanel.classList.add("is-open");
    window.requestAnimationFrame(() => elements.notesText.focus());
  }

  function saveActiveNote() {
    if (state.activeNoteUrl === null) {
      return;
    }
    const url = state.activeNoteUrl;
    const text = elements.notesText.value;
    if (text.trim()) {
      state.notes[url] = text;
    } else {
      delete state.notes[url];
    }
    writeLocalReview(); // durable local cache immediately
    if (SYNC.reachable) {
      setNoteStatus("saving");
      SYNC.pushNotes(notesBody, (ok) => {
        if (state.activeNoteUrl === url) {
          setNoteStatus(ok ? "saved" : "offline");
        }
      });
    } else {
      setNoteStatus("offline");
    }
  }

  function closeNotesPanel() {
    if (state.activeNoteUrl === null) {
      return;
    }
    window.clearTimeout(state.noteTimer);
    saveActiveNote(); // never lose the last edit
    state.activeNoteUrl = null;
    elements.notesPanel.classList.remove("is-open");
    renderSelectionPane(); // refresh the "Notes •" indicators
  }

  function cacheElements() {
    for (const id of [
      "loadingScreen", "viewTitle", "viewDescription", "metricGrid", "searchForm",
      "searchInput", "matchMode", "termLogic", "termLogicLabel", "searchHint",
      "clearSearch", "resultCount", "results", "pagination", "previousPage",
      "nextPage", "pageStatus", "expandHosts", "collapseAll", "tree",
      "resultFilter", "resultFilterClear",
    ]) {
      elements[id] = document.getElementById(id);
    }
  }

  function scheduleSearch() {
    window.clearTimeout(state.searchTimer);
    if (!elements.searchInput.value.trim()) {
      clearSearch();
      return;
    }
    elements.resultCount.textContent = "Searching…";
    state.searchTimer = window.setTimeout(runSearch, 450);
  }

  function bindEvents() {
    elements.searchForm.addEventListener("submit", (event) => {
      event.preventDefault();
      elements.resultCount.textContent = "Searching…";
      window.setTimeout(() => runSearch(true), 0);
    });
    elements.searchInput.addEventListener("input", scheduleSearch);
    elements.clearSearch.addEventListener("click", () => {
      clearSearch();
      clearSavedSearchState();
    });
    elements.matchMode.addEventListener("change", () => {
      updateSearchMode();
      scheduleSearch();
    });
    elements.termLogic.addEventListener("change", scheduleSearch);
    elements.previousPage.addEventListener("click", () => {
      state.page -= 1;
      renderResults();
    });
    elements.nextPage.addEventListener("click", () => {
      state.page += 1;
      renderResults();
    });
    elements.expandHosts.addEventListener("click", () => {
      for (const hostIndex of state.visibleHosts) {
        expandHost(hostIndex);
      }
    });
    elements.collapseAll.addEventListener("click", collapseAll);
    if (elements.resultFilter) {
      elements.resultFilter.addEventListener("input", () => {
        state.resultFilter = elements.resultFilter.value.trim().toLowerCase();
        state.page = 0; // a narrower filter can shrink the list past the current page
        elements.resultFilterClear.hidden = state.resultFilter === "";
        if (state.totalMatches) {
          renderResults();
        }
      });
      elements.resultFilterClear.addEventListener("click", () => {
        elements.resultFilter.value = "";
        state.resultFilter = "";
        state.page = 0;
        elements.resultFilterClear.hidden = true;
        if (state.totalMatches) {
          renderResults();
        }
        elements.resultFilter.focus();
      });
    }
  }

  function initialize() {
    if (!window.URL_TREE_DATA || window.URL_TREE_DATA.version !== 3) {
      throw new Error("URL tree data is missing or incompatible.");
    }
    cacheElements();
    const config = currentConfig();
    state.sourceMask = window.URL_TREE_DATA.sourceMasks[state.source];
    state.rootToHost = new Map(
      window.URL_TREE_DATA.hosts.map((host, index) => [host[HOST_ROOT], index])
    );
    state.hostNameToIndex = new Map(
      window.URL_TREE_DATA.hosts.map((host, index) => [host[HOST_NAME], index])
    );
    document.title = `URL Tree — ${INSTITUTION}`;
    mountHeaderControls();
    // Left pane is keyword-only: drop the title, description, metric grid and the
    // availability box. Counts move to the header; backup tools move to the
    // selection pane.
    document.querySelector(".search-panel .eyebrow")?.remove();
    elements.viewTitle?.remove();
    elements.viewDescription?.remove();
    elements.metricGrid?.remove();
    mountHeaderMetrics();
    loadReviewMarks();
    mountSelectionPane();
    mountNotesPanel();
    renderReviewTools();
    const legend = document.querySelector(".tree-legend");
    if (legend) {
      const selectedLegend = document.createElement("span");
      selectedLegend.append(Object.assign(document.createElement("i"), {
        className: "legend-dot selected-dot",
      }));
      selectedLegend.append(document.createTextNode(" Selected path"));
      legend.append(selectedLegend);
    }
    rebuildTree();
    updateSearchMode();
    bindEvents();
    const savedSearch = loadSearchState();
    if (savedSearch) {
      elements.searchInput.value = savedSearch.terms;
      if (savedSearch.matchMode) {
        elements.matchMode.value = savedSearch.matchMode;
      }
      if (savedSearch.termLogic) {
        elements.termLogic.value = savedSearch.termLogic;
      }
      updateSearchMode();
      if (savedSearch.terms.trim()) {
        runSearch(false);
      }
    }
    // Flush any sub-debounce pending change when the tab is hidden/closed so the
    // last action isn't lost before it syncs.
    window.addEventListener("pagehide", () => SYNC.flushAll());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        SYNC.flushAll();
      }
    });
    window.requestAnimationFrame(() => elements.loadingScreen.classList.add("is-hidden"));
  }

  async function hydrateFromServer() {
    // Runs after the initial localStorage-based render. If a server is present it
    // is authoritative: adopt its document. If the server is empty but this
    // browser has local work, seed the server from it (one-time migration). An
    // empty server never wipes non-empty local state.
    // Marks + selections come from the SHARED record (same for both reviewers);
    // notes come from this reviewer's PRIVATE record. They adopt independently so
    // a note never rides in on the shared list and vice-versa.
    const server = await SYNC.load();
    if (!server) {
      return; // no server this session — localStorage stays authoritative
    }
    startKeywordSync(server.search && server.search.terms);
    const serverShared =
      (server.marks && Object.keys(server.marks).length > 0) ||
      (Array.isArray(server.selections) && server.selections.length > 0);
    const serverNotes = server.notes && Object.keys(server.notes).length > 0;
    const localShared = Object.keys(state.marks).length > 0 || state.selections.size > 0;
    const localNotes = Object.keys(state.notes).length > 0;

    // If the shared record still carries stale auto-strikes (saved by older code),
    // drop them on adopt so they can't hide content, and push the cleaned set once.
    const rawServerMarks = server.marks && typeof server.marks === "object" ? server.marks : {};
    const cleanedServerMarks = manualMarks(rawServerMarks);
    const hadStaleAutos = Object.keys(rawServerMarks).length !== Object.keys(cleanedServerMarks).length;
    if (serverShared) {
      state.marks = cleanedServerMarks;
      state.selections = new Set(Array.isArray(server.selections) ? server.selections : []);
    }
    if (serverNotes) {
      state.notes = server.notes && typeof server.notes === "object" ? server.notes : {};
    }
    if (serverShared || serverNotes) {
      writeLocalReview();
    }

    // rebuildTree() clears the search box, so set the keywords AFTER it.
    if (serverShared) {
      rebuildTree();
    }
    if (server.search && typeof server.search.terms === "string") {
      elements.searchInput.value = server.search.terms;
      if (server.search.matchMode) {
        elements.matchMode.value = server.search.matchMode;
      }
      if (server.search.termLogic) {
        elements.termLogic.value = server.search.termLogic;
      }
      updateSearchMode();
    }
    if (elements.searchInput.value.trim()) {
      runSearch(false);
    }
    if (serverShared || serverNotes) {
      // Reflect adopted marks/selections/notes in the tree, pane, and metrics
      // (notes affect which struck nodes stay pinned in the selection pane).
      applyReviewState();
      renderSelectionPane();
      renderHeaderMetrics();
      updateReviewSummary();
    }

    // Seed a fresh server from this browser's local-only work (one-time), each
    // channel independently so an empty shared record doesn't wait on notes.
    if (!serverShared && localShared) {
      SYNC.pushShared(sharedBody);
    } else if (serverShared && hadStaleAutos) {
      SYNC.pushShared(sharedBody); // scrub the stale auto-strikes out of the DB once
    }
    if (!serverNotes && localNotes) {
      SYNC.pushNotes(notesBody);
    }
  }

  function showLoadError(message) {
    const loadingScreen = document.getElementById("loadingScreen");
    if (loadingScreen) {
      loadingScreen.innerHTML = `<div class="loading-mark">!</div><p>${message}</p>`;
    }
  }

  function loadTreeData(institution) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `data/tree-${encodeURIComponent(institution)}.js`;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("tree data failed to load"));
      document.head.append(script);
    });
  }

  // The tree data is loaded dynamically for the selected institution, then the app
  // initializes. This is what lets the institution dropdown pick different datasets.
  loadTreeData(INSTITUTION)
    .then(() => {
      try {
        initialize();
        hydrateFromServer().catch((error) => console.warn("Server sync unavailable", error));
      } catch (error) {
        console.error(error);
        showLoadError("The URL tree could not be loaded.");
      }
    })
    .catch((error) => {
      console.error(error);
      showLoadError(`Could not load data for “${INSTITUTION}”.`);
    });
})();
