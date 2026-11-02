/* Local AI Estimator static front-end.
 * All model data lives in data/models.js (window.MODELS). This file is the
 * calculator, chart renderer, URL-state sync, and tooltip layer.
 */
(() => {
    "use strict";

    const MODELS = window.MODELS || [];
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => Array.from(document.querySelectorAll(sel));

    const el = {
        archToggle: $("#archToggle"),
        unifiedRow: $("#unifiedRow"),
        splitRow: $("#splitRow"),
        unifiedInput: $("#unifiedInput"),
        unifiedUnit: $("#unifiedUnit"),
        ramInput: $("#ramInput"),
        ramUnit: $("#ramUnit"),
        vramInput: $("#vramInput"),
        vramUnit: $("#vramUnit"),
        ssdInput: $("#ssdInput"),
        ssdUnit: $("#ssdUnit"),
        ctxOn: $("#ctxOn"),
        ctxInput: $("#ctxInput"),
        ctxUnit: $("#ctxUnit"),
        moeSsd: $("#moeSsd"),
        moeRam: $("#moeRam"),
        moeRamWrap: $("#moeRamWrap"),
        engramSsd: $("#engramSsd"),
        resetBtn: $("#resetBtn"),
        archHint: $("#archHint"),
        offloadHint: $("#offloadHint"),
        summary: $("#summary"),
        dataNote: $("#dataNote"),
        chartSubtitle: $("#chartSubtitle"),
        sortMode: $("#sortMode"),
        legend: $("#legend"),
        emptyState: $("#emptyState"),
        chartStage: $("#chartStage"),
        chartWrap: $("#chartWrap"),
        yAxis: $("#yAxis"),
        plotScroll: $("#plotScroll"),
        plot: $("#plot"),
        grid: $("#grid"),
        bars: $("#bars"),
        tooltip: $("#tooltip"),
        chartDetail: $("#chartDetail"),
        detailBody: $("#detailBody"),
        detailClose: $("#detailClose"),
        statFamilies: $("#statFamilies"),
        statQuants: $("#statQuants"),
        statBars: $("#statBars"),
    };

    const TB = 1000; // decimal GB, matching the published safetensors/GGUF sizes
    const K = 1024;
    const DEFAULT_CTX = 32768;

    const state = {
        arch: "unified",
        unifiedGB: 0,
        ramGB: 0,
        vramGB: 0,
        ssdGB: 0,
        ctxTokens: DEFAULT_CTX,
        includeCtx: false,
        moeSsd: false,
        moeRam: false,
        engramSsd: false,
        sortMode: "score",
    };

    let allEntries = [];
    let visibleEntries = [];
    let entryData = new Map();
    let hoveredId = null;
    let selectedEntryId = null;
    let renderTimer = 0;

    /* ---------------- formatting ---------------- */

    function formatSize(gb) {
        if (!Number.isFinite(gb)) return "—";
        if (gb <= 0) return "0 GB";
        if (gb >= TB) return `${(gb / TB).toFixed(gb >= 10 * TB ? 1 : 2)} TB`;
        if (gb >= 100) return `${gb.toFixed(0)} GB`;
        if (gb >= 10) return `${gb.toFixed(1)} GB`;
        return `${gb.toFixed(2)} GB`;
    }

    function formatTokens(tokens) {
        if (!Number.isFinite(tokens) || tokens <= 0) return "0";
        if (tokens >= 1e6) {
            const v = tokens / 1e6;
            return `${Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)}M`;
        }
        if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
        return String(Math.round(tokens));
    }

    function formatPct(p) {
        if (!Number.isFinite(p)) return "—";
        if (p >= 10) return `${p.toFixed(0)}%`;
        if (p >= 1) return `${p.toFixed(1)}%`;
        return `${p.toFixed(2)}%`;
    }

    function esc(s) {
        return String(s ?? "").replace(
            /[&<>"']/g,
            (c) =>
                ({
                    "&": "&amp;",
                    "<": "&lt;",
                    ">": "&gt;",
                    '"': "&quot;",
                    "'": "&#39;",
                })[c],
        );
    }

    function num(v) {
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
    }

    /* ---------------- state / inputs ---------------- */

    function toGB(input, unitSel) {
        return num(input.value) * (unitSel.value === "TB" ? TB : 1);
    }

    function readState() {
        const arch = state.arch;
        state.unifiedGB = toGB(el.unifiedInput, el.unifiedUnit);
        state.ramGB = toGB(el.ramInput, el.ramUnit);
        state.vramGB = toGB(el.vramInput, el.vramUnit);
        state.ssdGB = toGB(el.ssdInput, el.ssdUnit);
        state.ctxTokens = Math.max(
            0,
            Math.round(num(el.ctxInput.value) * num(el.ctxUnit.value)),
        );
        state.includeCtx = el.ctxOn.checked;
        state.moeSsd = el.moeSsd.checked;
        state.moeRam = el.moeRam.checked && arch === "split";
        state.engramSsd = el.engramSsd.checked;
        state.sortMode = el.sortMode.value || "score";
        return state;
    }

    function hasMemoryLimit() {
        return state.arch === "unified"
            ? state.unifiedGB > 0
            : state.ramGB > 0 || state.vramGB > 0;
    }

    function applyArchitecture() {
        const split = state.arch === "split";
        $$("#archToggle button").forEach((b) => {
            const on = b.dataset.arch === state.arch;
            b.classList.toggle("active", on);
            b.setAttribute("aria-selected", String(on));
        });
        el.unifiedRow.hidden = split;
        el.splitRow.hidden = !split;
        el.moeRamWrap.hidden = !split;
        if (!split) {
            el.moeRam.checked = false;
            state.moeRam = false;
        }
        el.archHint.textContent = split
            ? "A discrete GPU with its own VRAM and system RAM for CPU offload."
            : "Apple Silicon, Strix Halo, Grace Blackwell and other shared-memory systems.";
        el.offloadHint.textContent = split
            ? "CPU RAM offload keeps inactive experts in system RAM; SSD offload streams them instead."
            : "SSD offloading streams experts; only the active experts stay resident.";
        el.ctxInput.disabled = !el.ctxOn.checked;
        el.ctxUnit.disabled = !el.ctxOn.checked;
    }

    function setGBInput(input, unitSel, gb) {
        if (!gb || gb <= 0) {
            input.value = "";
            return;
        }
        if (gb >= TB) {
            input.value = Number((gb / TB).toFixed(2));
            unitSel.value = "TB";
        } else {
            input.value = Number(gb.toFixed(2));
            unitSel.value = "GB";
        }
    }

    function setCtxInput(tokens) {
        if (!tokens || tokens <= 0) {
            el.ctxInput.value = "";
            el.ctxUnit.value = "1";
            return;
        }
        if (tokens >= 1000000 && tokens % 1000000 === 0) {
            el.ctxInput.value = tokens / 1000000;
            el.ctxUnit.value = "1000000";
        } else if (tokens >= K && tokens % K === 0) {
            el.ctxInput.value = tokens / K;
            el.ctxUnit.value = String(K);
        } else {
            el.ctxInput.value = tokens;
            el.ctxUnit.value = "1";
        }
    }

    function loadFromURL() {
        const p = new URLSearchParams(location.search);
        state.arch = p.get("arch") === "split" ? "split" : "unified";
        setGBInput(el.unifiedInput, el.unifiedUnit, num(p.get("ram")));
        setGBInput(el.ramInput, el.ramUnit, num(p.get("ram")));
        setGBInput(el.vramInput, el.vramUnit, num(p.get("vram")));
        setGBInput(el.ssdInput, el.ssdUnit, num(p.get("ssd")));

        const ctx = num(p.get("ctx")) || DEFAULT_CTX;
        setCtxInput(ctx);
        el.ctxOn.checked = p.get("ctxOn") === "1";
        el.moeSsd.checked = p.get("moeSsd") === "1";
        el.moeRam.checked = p.get("moeRam") === "1";
        el.engramSsd.checked = p.get("engramSsd") === "1";
        el.sortMode.value = p.get("sort") || "score";
        if (state.arch === "split" && el.moeSsd.checked && el.moeRam.checked)
            el.moeRam.checked = false;
        applyArchitecture();
    }

    function syncURL() {
        const p = new URLSearchParams();
        p.set("arch", state.arch);
        const ram = state.arch === "unified" ? state.unifiedGB : state.ramGB;
        if (ram > 0) p.set("ram", String(Number(ram.toFixed(2))));
        if (state.arch === "split" && state.vramGB > 0)
            p.set("vram", String(Number(state.vramGB.toFixed(2))));
        if (state.ssdGB > 0)
            p.set("ssd", String(Number(state.ssdGB.toFixed(2))));
        if (state.includeCtx) p.set("ctxOn", "1");
        if (state.ctxTokens > 0) p.set("ctx", String(state.ctxTokens));
        if (state.moeSsd) p.set("moeSsd", "1");
        if (state.moeRam) p.set("moeRam", "1");
        if (state.engramSsd) p.set("engramSsd", "1");
        if (state.sortMode !== "score") p.set("sort", state.sortMode);
        const qs = p.toString();
        try {
            history.replaceState(
                null,
                "",
                qs ? `${location.pathname}?${qs}` : location.pathname,
            );
        } catch {
            // file:// in some browsers blocks replaceState; the app still works.
        }
    }

    /* ---------------- model math ---------------- */

    function baseLabel(model) {
        if (model.expertParamsB > 0) {
            if (model.engramParamsB > 0) return "FP8 + FP4 + Engram";
            if (model.base.bits.experts >= 12) return "BF16";
            if (model.base.bits.experts <= 4.6) {
                return model.base.bits.dense >= 12 ? "BF16 + FP4" : "FP8 + FP4";
            }
            return model.base.bits.dense >= 12 ? "BF16 + FP8" : "FP8";
        }
        return model.base.bits.dense >= 12 ? "BF16" : "FP8";
    }

    function quantLabel(q) {
        if (!q) return "";
        const t =
            q.token === "IQ4_KS-MIX"
                ? "IQ4_KS-mix"
                : q.token === "Q2_A"
                  ? "Q2_a"
                  : q.token;
        return q.label.includes("UD-") ? `UD-${t}` : t;
    }

    function calcSize(model, quant, ctxTokens, includeCtx) {
        const bits = quant ? quant.bits : model.base.bits;
        const dense = (model.denseParamsB * (bits.dense || 0)) / 8;
        const experts = (model.expertParamsB * (bits.experts || 0)) / 8;
        const engram = (model.engramParamsB * (bits.engram || 0)) / 8;
        let kv = 0;
        if (includeCtx && ctxTokens > 0 && model.kv) {
            const effCtx = model.context
                ? Math.min(ctxTokens, model.context)
                : ctxTokens;
            const full = (model.kv.fullBytesPerToken || 0) * effCtx;
            const slideWin = model.kv.slidingWindow || 0;
            const slide =
                (model.kv.slidingBytesPerToken || 0) *
                (slideWin ? Math.min(effCtx, slideWin) : 0);
            kv = (full + slide) / 1e9;
        }
        return {
            dense,
            experts,
            engram,
            kv,
            weights: dense + experts + engram,
            total: dense + experts + engram + kv,
        };
    }

    function buildEntries() {
        const out = [];
        for (const model of MODELS) {
            for (const variant of model.variants) {
                out.push({
                    id: `${model.id}|${variant.slug || variant.name}|base`,
                    model,
                    variant,
                    quant: null,
                    bits: model.base.bits,
                    accuracy: 1,
                    accuracySource: "base",
                    baseScore: variant.score,
                    adjusted: variant.score,
                    scoreEstimated: !!variant.scoreEstimated,
                    delta: 0,
                });
                for (const q of model.quants) {
                    out.push({
                        id: `${model.id}|${variant.slug || variant.name}|${q.token}`,
                        model,
                        variant,
                        quant: q,
                        bits: q.bits,
                        accuracy: q.accuracy,
                        accuracySource: q.accuracySource,
                        baseScore: variant.score,
                        adjusted: variant.score * q.accuracy,
                        scoreEstimated: !!variant.scoreEstimated,
                        delta: (1 - q.accuracy) * 100,
                    });
                }
            }
        }
        return out;
    }

    function evalPath(model, size, opts) {
        const frac = model.activeExpertFraction || 0;
        const engramOnSsd = !!opts.engramSsd && size.engram > 0;
        const memEngram = engramOnSsd ? 0 : size.engram;
        let usedMoeSsd = false;
        let usedMoeRam = false;
        let ssd = engramOnSsd ? size.engram : 0;

        if (state.arch === "unified") {
            let mem = size.dense + size.kv + memEngram;
            if (size.experts > 0) {
                if (opts.moeSsd) {
                    mem += size.experts * frac;
                    ssd += size.experts;
                    usedMoeSsd = true;
                } else {
                    mem += size.experts;
                }
            }
            return {
                fit: mem <= state.unifiedGB + 1e-9 && ssd <= state.ssdGB + 1e-9,
                mode: state.arch,
                mem,
                vram: mem,
                ram: 0,
                ssd,
                usedMoeSsd,
                usedMoeRam,
                usedEngramSsd: engramOnSsd,
            };
        }

        let vram = size.dense + size.kv;
        let ram = memEngram;
        if (size.experts > 0) {
            if (opts.moeSsd) {
                vram += size.experts * frac;
                ssd += size.experts;
                usedMoeSsd = true;
            } else if (opts.moeRam) {
                const active = size.experts * frac;
                const inactive = size.experts - active;
                const baseVram = size.dense + size.kv + active;
                const spare = Math.max(0, state.vramGB - baseVram);
                const inactiveOnGpu = Math.min(inactive, spare);
                vram = baseVram + inactiveOnGpu;
                ram += inactive - inactiveOnGpu;
                usedMoeRam = true;
            } else {
                vram += size.experts;
            }
        }
        return {
            fit:
                vram <= state.vramGB + 1e-9 &&
                ram <= state.ramGB + 1e-9 &&
                ssd <= state.ssdGB + 1e-9,
            mode: state.arch,
            mem: vram,
            vram,
            ram,
            ssd,
            usedMoeSsd,
            usedMoeRam,
            usedEngramSsd: engramOnSsd,
        };
    }

    function evaluate(model, size) {
        const noOff = evalPath(model, size, {
            moeSsd: false,
            moeRam: false,
            engramSsd: false,
        });
        if (!hasMemoryLimit()) {
            return { ...noOff, fit: true, labels: [], limited: false };
        }
        if (noOff.fit) {
            return { ...noOff, labels: [], limited: true };
        }
        const opts =
            state.arch === "unified"
                ? {
                      moeSsd: state.moeSsd,
                      moeRam: false,
                      engramSsd: state.engramSsd,
                  }
                : {
                      moeSsd: state.moeSsd,
                      moeRam: state.moeRam,
                      engramSsd: state.engramSsd,
                  };

        if (!opts.moeSsd && !opts.moeRam && !opts.engramSsd) {
            return { ...noOff, fit: false, labels: [], limited: true };
        }

        const off = evalPath(model, size, opts);
        const labels = [];
        if (off.fit) {
            if (off.usedMoeSsd) labels.push({ type: "ssd", text: "MoE SSD" });
            if (off.usedMoeRam) labels.push({ type: "cpu", text: "CPU RAM" });
            if (off.usedEngramSsd)
                labels.push({ type: "engram", text: "Engram SSD" });
        }
        return { ...off, labels, limited: true };
    }

    /* ---------------- chart ---------------- */

    function isLight(hex) {
        const h = String(hex || "").replace("#", "");
        if (h.length < 6) return false;
        const r = parseInt(h.slice(0, 2), 16);
        const g = parseInt(h.slice(2, 4), 16);
        const b = parseInt(h.slice(4, 6), 16);
        return 0.299 * r + 0.587 * g + 0.114 * b > 150;
    }

    function renderLegend() {
        const companies = new Map();
        for (const m of MODELS) {
            if (!companies.has(m.company))
                companies.set(m.company, {
                    name: m.company,
                    color: m.color,
                    count: 0,
                });
            companies.get(m.company).count +=
                m.variants.length * (m.quants.length + 1);
        }
        el.legend.innerHTML = [...companies.values()]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(
                (c) =>
                    `<span class="legend-item" title="${esc(c.name)} · ${c.count} bars"><span class="legend-dot" style="background:${esc(c.color)};color:${esc(c.color)}"></span>${esc(c.name)}</span>`,
            )
            .join("");
    }

    function renderChart(entries) {
        const w = window.innerWidth;
        const plotHeight = w < 700 ? 230 : 300;
        const labelHeight = w < 700 ? 190 : 230;
        const topGutter = w < 700 ? 36 : 42;
        const barAreaHeight = plotHeight - topGutter;
        const baseCol = w < 700 ? 60 : 72;
        const padLeft = w < 700 ? 12 : 20;
        const padRight = w < 700 ? 24 : 40;
        const available = Math.max(320, el.plotScroll.clientWidth || w - 100);
        const inner = Math.max(120, available - padLeft - padRight);
        const colWidth = Math.max(
            baseCol,
            Math.min(300, inner / Math.max(1, entries.length)),
        );
        const barWidth = Math.max(30, Math.min(56, colWidth * 0.7));
        const maxAdjusted = Math.max(0, ...entries.map((e) => e.adjusted));
        const tickStep = maxAdjusted <= 10 ? 1 : maxAdjusted <= 20 ? 2 : 5;
        const maxScore = Math.max(
            tickStep * 2,
            Math.ceil(maxAdjusted / tickStep) * tickStep,
        );

        const contentWidth = padLeft + entries.length * colWidth + padRight;
        const plotWidth = Math.max(available, contentWidth);
        el.plot.style.setProperty("--plot-height", `${plotHeight}px`);
        el.plot.style.setProperty("--label-height", `${labelHeight}px`);
        el.plot.style.setProperty("--col-width", `${colWidth}px`);
        el.plot.style.setProperty("--bar-width", `${barWidth}px`);
        el.plot.style.setProperty("--pad-left", `${padLeft}px`);
        el.plot.style.setProperty("--pad-right", `${padRight}px`);
        el.plot.style.width = `${plotWidth}px`;
        el.yAxis.style.height = `${plotHeight}px`;

        // y-axis + grid
        el.yAxis.innerHTML = "";
        el.grid.innerHTML = "";
        for (let v = 0; v <= maxScore + 1e-9; v += tickStep) {
            const bottom = (v / maxScore) * barAreaHeight;
            const tick = document.createElement("div");
            tick.className = `y-tick${v === 0 ? " zero" : ""}`;
            tick.style.bottom = `${bottom}px`;
            tick.textContent = String(v);
            el.yAxis.appendChild(tick);

            const line = document.createElement("div");
            line.className = `grid-line${v === 0 ? " zero" : ""}`;
            line.style.bottom = `${bottom}px`;
            el.grid.appendChild(line);
        }

        el.bars.innerHTML = "";
        entryData = new Map();
        const frag = document.createDocumentFragment();

        for (const entry of entries) {
            const size =
                entry.size ||
                calcSize(
                    entry.model,
                    entry.quant,
                    state.ctxTokens,
                    state.includeCtx,
                );
            const ev = entry.ev || evaluate(entry.model, size);
            entryData.set(entry.id, { entry, size, ev });

            const barH = Math.max(
                2,
                (entry.adjusted / maxScore) * barAreaHeight,
            );
            const col = document.createElement("div");
            col.className = "bar-col";
            col.dataset.id = entry.id;
            col.style.setProperty("--bar-height", `${barH}px`);
            col.style.setProperty(
                "--bar-color",
                entry.model.color || "#6ee7ff",
            );

            const meta = document.createElement("div");
            meta.className = "bar-meta";
            if (entry.quant) {
                const delta = document.createElement("span");
                if (entry.delta < 0.05) {
                    delta.className = "bar-delta lossless";
                    delta.textContent = "0%";
                } else {
                    delta.className = `bar-delta${entry.accuracySource === "estimated" ? " estimated" : ""}`;
                    delta.textContent = `−${formatPct(entry.delta)}`;
                }
                meta.appendChild(delta);
            }

            const bar = document.createElement("div");
            bar.className = "bar";
            bar.style.height = `${barH}px`;
            bar.style.background = entry.model.color || "#6ee7ff";
            if (barH > 26) {
                const sc = document.createElement("span");
                sc.className = `bar-score${isLight(entry.model.color) ? "" : " light"}`;
                sc.textContent = `${entry.scoreEstimated ? "~" : ""}${entry.adjusted.toFixed(1)}`;
                bar.appendChild(sc);
            }

            const label = document.createElement("div");
            label.className = "bar-label";

            const sizeEl = document.createElement("div");
            sizeEl.className = "label-size";
            sizeEl.textContent = formatSize(size.total);
            label.appendChild(sizeEl);

            const nameEl = document.createElement("div");
            nameEl.className = "label-name";
            nameEl.title = `${entry.variant.name} · ${entry.model.company}`;
            if (entry.model.logo) {
                const img = document.createElement("img");
                img.src = entry.model.logo;
                img.alt = "";
                img.loading = "lazy";
                img.onerror = () => {
                    img.style.display = "none";
                };
                if (entry.model.logo.endsWith(".jpg")) {
                    img.style.background = "rgba(255,255,255,0.92)";
                    img.style.padding = "1px";
                }
                nameEl.appendChild(img);
            }
            const nameText = document.createElement("span");
            nameText.textContent = entry.variant.name;
            nameEl.appendChild(nameText);
            label.appendChild(nameEl);

            const qEl = document.createElement("div");
            qEl.className = "label-quant";
            if (entry.quant) {
                const qb = document.createElement("span");
                qb.className = "qbadge";
                qb.textContent = quantLabel(entry.quant);
                qEl.appendChild(qb);
            } else {
                const qb = document.createElement("span");
                qb.className = "qbadge";
                qb.textContent = `Base · ${baseLabel(entry.model)}`;
                qEl.appendChild(qb);
            }
            label.appendChild(qEl);

            if (ev.labels && ev.labels.length) {
                const badges = document.createElement("div");
                badges.className = "label-badges";
                for (const b of ev.labels) {
                    const span = document.createElement("span");
                    span.className = `badge ${b.type}`;
                    span.textContent = b.text;
                    badges.appendChild(span);
                }
                label.appendChild(badges);
            }

            col.appendChild(meta);
            col.appendChild(bar);
            col.appendChild(label);
            frag.appendChild(col);
        }

        el.bars.appendChild(frag);
    }

    /* ---------------- tooltip ---------------- */

    function tooltipHTML(entry, size, ev) {
        const model = entry.model;
        const quant = entry.quant;
        const limited = hasMemoryLimit();
        const fitText = !limited
            ? "No memory limit set"
            : ev.fit
              ? "Fits your limits."
              : "Does not fit your limits.";

        let resident = "";
        if (ev.mode === "unified") {
            resident = `<div class="tt-row"><span>Resident memory</span><span>${formatSize(ev.mem)}</span></div>`;
        } else {
            resident = `<div class="tt-row"><span>VRAM / CPU RAM</span><span>${formatSize(ev.vram)} / ${formatSize(ev.ram)}</span></div>`;
        }
        const ssd =
            ev.ssd > 0
                ? `<div class="tt-row"><span>SSD offload</span><span>${formatSize(ev.ssd)}</span></div>`
                : "";

        return `
      <div class="tt-head">
        <div>
          <div class="tt-title">${esc(entry.variant.name)}</div>
          <div class="tt-sub">${esc(model.company)} · ${esc(quant ? quantLabel(quant) : `Base · ${baseLabel(model)}`)}</div>
        </div>
        <div class="tt-score"><strong>${entry.scoreEstimated ? "~" : ""}${entry.adjusted.toFixed(2)}</strong><span>AAI adj.</span></div>
      </div>
      <div class="tt-row"><span>Total footprint</span><span><strong>${formatSize(size.total)}</strong></span></div>
      ${resident}
      ${ssd}
      <div class="tt-note ${ev.fit ? "tt-fit" : "tt-nofit"}">${fitText}</div>
      <div class="tt-note">Click the bar for the full breakdown.</div>
    `;
    }

    function detailHTML(entry, size, ev) {
        const model = entry.model;
        const quant = entry.quant;
        const limited = hasMemoryLimit();
        const sourceLabel =
            entry.accuracySource === "measured"
                ? "Measured"
                : entry.accuracySource === "base"
                  ? "Base precision"
                  : "Estimated";
        const fitText = !limited
            ? "No memory limit set"
            : ev.fit
              ? "Fits your limits."
              : "Does not fit your limits.";
        const effCtx = model.context
            ? Math.min(state.ctxTokens, model.context)
            : state.ctxTokens;
        const ctxCapped = state.ctxTokens > effCtx;
        const row = (label, value) =>
            `<div class="detail-row"><span>${label}</span><span>${value}</span></div>`;
        const badges =
            ev.labels && ev.labels.length
                ? `<div class="tt-badges">${ev.labels.map((b) => `<span class="badge ${b.type}">${esc(b.text)}</span>`).join("")}</div>`
                : "";

        const scoreRows = [];
        scoreRows.push(
            row(
                "Base score",
                `${entry.scoreEstimated ? "~" : ""}${entry.baseScore.toFixed(2)}${entry.scoreEstimated ? " · estimate" : ""}`,
            ),
        );
        if (quant)
            scoreRows.push(row("Quant penalty", `−${formatPct(entry.delta)}`));
        scoreRows.push(row("Accuracy source", sourceLabel));

        const footprintRows = [];
        footprintRows.push(row("Weights", formatSize(size.weights)));
        footprintRows.push(row("· dense / attention", formatSize(size.dense)));
        if (size.experts > 0)
            footprintRows.push(row("· MoE experts", formatSize(size.experts)));
        if (size.engram > 0)
            footprintRows.push(row("· Engram tables", formatSize(size.engram)));
        if (size.kv > 0)
            footprintRows.push(
                row(
                    `· KV cache (${formatTokens(effCtx)}${ctxCapped ? " · capped" : ""})`,
                    formatSize(size.kv),
                ),
            );
        footprintRows.push(
            row(
                "<strong>Total footprint</strong>",
                `<strong>${formatSize(size.total)}</strong>`,
            ),
        );

        const memoryRows = [];
        if (ev.mode === "unified") {
            memoryRows.push(row("Resident memory", formatSize(ev.mem)));
        } else {
            memoryRows.push(row("Resident VRAM", formatSize(ev.vram)));
            memoryRows.push(row("Resident CPU RAM", formatSize(ev.ram)));
        }
        if (ev.ssd > 0) memoryRows.push(row("SSD offload", formatSize(ev.ssd)));

        const notes = [];
        if (entry.scoreEstimated)
            notes.push(
                "AAI is estimated because Artificial Analysis has not published an index for this model.",
            );
        notes.push(esc(model.kv?.note || "Sizing estimate."));
        if (ctxCapped)
            notes.push(
                `KV capped at this model's ${formatTokens(model.context)} max context.`,
            );
        if (quant)
            notes.push(
                `Published quant size ${esc(quant.sizeGB.toFixed(1))} GB; effective bits calibrated to that total.`,
            );

        return `
      <div class="detail-top">
        <div>
          <div class="detail-kicker">${esc(model.company)} · ${esc(quant ? quantLabel(quant) : `Base · ${baseLabel(model)}`)}</div>
          <h3 class="detail-title">${esc(entry.variant.name)}</h3>
        </div>
        <div class="detail-score"><strong>${entry.scoreEstimated ? "~" : ""}${entry.adjusted.toFixed(2)}</strong><span>AAI adjusted</span></div>
      </div>
      <div class="detail-cols">
        <section class="detail-card">
          <h4>Score</h4>
          ${scoreRows.join("")}
        </section>
        <section class="detail-card">
          <h4>Footprint</h4>
          ${footprintRows.join("")}
        </section>
        <section class="detail-card">
          <h4>Memory fit</h4>
          ${memoryRows.join("")}
          ${badges}
          <div class="detail-fit ${ev.fit ? "tt-fit" : "tt-nofit"}">${fitText}</div>
        </section>
      </div>
      <div class="detail-footer">
        <div class="detail-notes">${notes.join(" ")}</div>
        <a class="btn detail-hf" href="${esc(model.hf)}" target="_blank" rel="noopener">Hugging Face ↗</a>
      </div>
    `;
    }

    function positionTooltip(e) {
        const pad = 14;
        const r = el.tooltip.getBoundingClientRect();
        let x = e.clientX + 16;
        let y = e.clientY + 16;
        if (x + r.width > window.innerWidth - pad) x = e.clientX - r.width - 16;
        if (y + r.height > window.innerHeight - pad)
            y = e.clientY - r.height - 16;
        el.tooltip.style.left = `${Math.max(pad, x)}px`;
        el.tooltip.style.top = `${Math.max(pad, y)}px`;
    }

    function showTooltip(e, id) {
        const data = entryData.get(id);
        if (!data) return;
        el.tooltip.innerHTML = tooltipHTML(data.entry, data.size, data.ev);
        el.tooltip.hidden = false;
        positionTooltip(e);
    }

    function hideTooltip() {
        el.tooltip.hidden = true;
        hoveredId = null;
    }

    function refreshChartForDetailLayout() {
        if (!visibleEntries.length || el.chartWrap.style.display === "none")
            return;
        renderChart(visibleEntries);
        $$(".bar-col").forEach((col) =>
            col.classList.toggle(
                "selected",
                col.dataset.id === selectedEntryId,
            ),
        );
    }

    function showDetail(id) {
        const data = entryData.get(id);
        if (!data) return;
        const opening = !el.chartStage.classList.contains("has-detail");
        selectedEntryId = id;
        el.detailBody.innerHTML = detailHTML(data.entry, data.size, data.ev);
        el.chartDetail.hidden = false;
        el.chartStage.classList.add("has-detail");
        if (opening) refreshChartForDetailLayout();
        $$(".bar-col").forEach((col) =>
            col.classList.toggle("selected", col.dataset.id === id),
        );
    }

    function hideDetail() {
        const closing = el.chartStage.classList.contains("has-detail");
        selectedEntryId = null;
        el.chartDetail.hidden = true;
        el.detailBody.innerHTML = "";
        el.chartStage.classList.remove("has-detail");
        $$(".bar-col.selected").forEach((col) =>
            col.classList.remove("selected"),
        );
        if (closing) refreshChartForDetailLayout();
    }

    /* ---------------- render ---------------- */

    function sortDescription() {
        if (state.sortMode === "sizeAsc")
            return "sorted by size, smallest first";
        if (state.sortMode === "sizeDesc")
            return "sorted by size, largest first";
        return "sorted by quant-adjusted AAI score";
    }

    function render() {
        readState();
        applyArchitecture();
        allEntries = buildEntries();
        for (const entry of allEntries) {
            entry.size = calcSize(
                entry.model,
                entry.quant,
                state.ctxTokens,
                state.includeCtx,
            );
            entry.ev = evaluate(entry.model, entry.size);
        }
        visibleEntries = hasMemoryLimit()
            ? allEntries.filter((e) => e.ev.fit)
            : allEntries.slice();
        visibleEntries.sort((a, b) => {
            if (state.sortMode === "sizeAsc") {
                return (
                    a.size.total - b.size.total ||
                    b.adjusted - a.adjusted ||
                    a.model.name.localeCompare(b.model.name)
                );
            }
            if (state.sortMode === "sizeDesc") {
                return (
                    b.size.total - a.size.total ||
                    b.adjusted - a.adjusted ||
                    a.model.name.localeCompare(b.model.name)
                );
            }
            return (
                b.adjusted - a.adjusted ||
                b.baseScore - a.baseScore ||
                a.model.name.localeCompare(b.model.name) ||
                (a.quant ? 1 : 0) - (b.quant ? 1 : 0) ||
                (a.quant?.sizeGB || 0) - (b.quant?.sizeGB || 0)
            );
        });

        const totalBars = allEntries.length;
        const fitBars = visibleEntries.length;
        const limited = hasMemoryLimit();

        el.statFamilies.textContent = MODELS.length;
        el.statQuants.textContent = MODELS.reduce(
            (n, m) => n + m.quants.length,
            0,
        );
        el.statBars.textContent = totalBars;

        if (!limited) {
            el.summary.innerHTML = `Showing all <strong>${totalBars}</strong> bars. Enter memory above to filter.`;
            el.dataNote.textContent = "No memory configured";
            el.chartSubtitle.textContent = `All ${totalBars} bars · ${sortDescription()}.`;
        } else {
            const memText =
                state.arch === "unified"
                    ? `${formatSize(state.unifiedGB)} unified`
                    : `${formatSize(state.ramGB)} RAM · ${state.vramGB > 0 ? `${formatSize(state.vramGB)} VRAM` : "VRAM not set"}`;
            const ssdText =
                state.ssdGB > 0
                    ? ` · ${formatSize(state.ssdGB)} SSD`
                    : " · no SSD";
            el.summary.innerHTML = `<strong>${fitBars}</strong> of ${totalBars} bars fit in ${memText}${ssdText}.`;
            el.dataNote.textContent = `${memText}${ssdText}${state.includeCtx ? ` · context ${formatTokens(state.ctxTokens)}` : ""}`;
            el.chartSubtitle.textContent = `${fitBars} of ${totalBars} bars fit · ${sortDescription()}.`;
        }

        const empty = limited && fitBars === 0;
        el.emptyState.hidden = !empty;
        el.chartWrap.style.display = empty ? "none" : "";
        el.legend.hidden = false;

        if (!empty) {
            renderChart(visibleEntries);
            if (selectedEntryId) {
                if (entryData.has(selectedEntryId)) showDetail(selectedEntryId);
                else hideDetail();
            }
        } else {
            el.bars.innerHTML = "";
            el.grid.innerHTML = "";
            el.yAxis.innerHTML = "";
            hideDetail();
        }
        hideTooltip();
    }

    function scheduleRender() {
        window.clearTimeout(renderTimer);
        renderTimer = window.setTimeout(render, 70);
    }

    function onInput() {
        readState();
        syncURL();
        scheduleRender();
    }

    function setArch(arch) {
        state.arch = arch;
        if (arch !== "split") el.moeRam.checked = false;
        applyArchitecture();
        onInput();
    }

    function reset() {
        state.arch = "unified";
        el.unifiedInput.value = "";
        el.ramInput.value = "";
        el.vramInput.value = "";
        el.ssdInput.value = "";
        el.unifiedUnit.value = "GB";
        el.ramUnit.value = "GB";
        el.vramUnit.value = "GB";
        el.ssdUnit.value = "TB";
        el.ctxOn.checked = false;
        setCtxInput(DEFAULT_CTX);
        el.moeSsd.checked = false;
        el.moeRam.checked = false;
        el.engramSsd.checked = false;
        applyArchitecture();
        onInput();
    }

    /* ---------------- events ---------------- */

    el.archToggle.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-arch]");
        if (btn) setArch(btn.dataset.arch);
    });

    for (const input of [
        el.unifiedInput,
        el.ramInput,
        el.vramInput,
        el.ssdInput,
        el.ctxInput,
    ]) {
        input.addEventListener("input", onInput);
    }
    for (const sel of [
        el.unifiedUnit,
        el.ramUnit,
        el.vramUnit,
        el.ssdUnit,
        el.ctxUnit,
        el.sortMode,
    ]) {
        sel.addEventListener("change", onInput);
    }
    for (const cb of [el.ctxOn, el.moeSsd, el.moeRam, el.engramSsd]) {
        cb.addEventListener("change", onInput);
    }
    el.moeSsd.addEventListener("change", () => {
        if (el.moeSsd.checked && state.arch === "split")
            el.moeRam.checked = false;
        if (el.moeSsd.checked) onInput();
    });
    el.moeRam.addEventListener("change", () => {
        if (el.moeRam.checked) el.moeSsd.checked = false;
        if (el.moeRam.checked) onInput();
    });
    el.resetBtn.addEventListener("click", reset);

    el.bars.addEventListener("mousemove", (e) => {
        const bar = e.target.closest(".bar");
        if (!bar) {
            if (hoveredId) hideTooltip();
            return;
        }
        const col = bar.closest(".bar-col");
        if (col.dataset.id !== hoveredId) {
            hoveredId = col.dataset.id;
            showTooltip(e, hoveredId);
        } else {
            positionTooltip(e);
        }
    });
    el.bars.addEventListener("mouseleave", hideTooltip);
    el.bars.addEventListener("click", (e) => {
        const col = e.target.closest(".bar-col");
        if (!col) return;
        hideTooltip();
        showDetail(col.dataset.id);
    });
    el.detailClose.addEventListener("click", hideDetail);
    el.plotScroll.addEventListener("scroll", hideTooltip, { passive: true });
    window.addEventListener("resize", () => {
        hideTooltip();
        scheduleRender();
    });
    window.addEventListener("popstate", () => {
        loadFromURL();
        render();
    });

    /* ---------------- boot ---------------- */

    setCtxInput(DEFAULT_CTX);
    loadFromURL();
    renderLegend();
    render();
})();
