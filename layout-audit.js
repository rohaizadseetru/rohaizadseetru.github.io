/* eslint-disable */
/**
 * layout-audit — find text that collides, spills or gets clipped.
 *
 *   await layoutAudit()                 scroll the page, then report
 *   await layoutAudit({ scroll: false })  report the current viewport only
 *   layoutAudit.clear()                 remove the highlights
 *
 * Run it in a REAL browser. It is deliberately not usable from a headless or
 * backgrounded preview: those report `document.hidden`, which parks
 * IntersectionObserver and requestAnimationFrame, so scroll-revealed content
 * never arrives and the audit silently measures a half-built page. The script
 * refuses to run in that state rather than hand you a clean bill of health it
 * cannot support.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS FUSSIER THAN IT LOOKS
 *
 * A naive "do these two boxes intersect" pass over this codebase produced far
 * more false positives than real findings — six distinct classes of them, each
 * of which looked like a genuine bug until it was checked by hand. Every guard
 * below exists because of one:
 *
 *   1. display:none subtrees. A child of a hidden parent reports its OWN
 *      computed display, not `none`. The hidden desktop build on /tender
 *      produced 55 phantom overlaps this way.
 *   2. Collapsed accordions. A panel at max-height:0 still returns client
 *      rects for its children. The bio expanders on We Are MRT Corp and the
 *      SITE MAP panel both read as overlapping content underneath them.
 *   3. Clipped overflow. A 400px paragraph inside a 176px scroller overlaps
 *      whatever follows it — on paper. Only the visible slice counts, so every
 *      rect is intersected with its clipping ancestors before comparison.
 *   4. opacity:0 cross-fade layers. Card front and back stacked on one box:
 *      real geometry, invisible ink.
 *   5. Inline elements that wrap. An inline <span> spanning three lines has a
 *      bounding box covering all three, so two consecutive spans in one
 *      paragraph ALWAYS appear to overlap. Fixed by comparing per-line rects
 *      from getClientRects() rather than the bounding box.
 *   6. Opaque overlays. An open dropdown legitimately covers the table beneath
 *      it. If the thing in front is opaque, it is occluding, not colliding.
 * ---------------------------------------------------------------------------
 */
;(function () {
  var TEXT_SEL = 'h1,h2,h3,h4,h5,h6,p,li,td,th,button,label,a,span,dt,dd,figcaption,blockquote'
  var HILITE = '__layout_audit_hilite'

  function isTextLeaf(el) {
    // Only elements holding their own text. A wrapper whose text comes from a
    // child would double-count and overlap its own descendant.
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 && n.textContent.trim()) return true
    }
    return false
  }

  function clipBox(el) {
    // The intersection of every clipping ancestor — the region this element is
    // actually allowed to paint in. Guards 2 and 3.
    var x1 = -Infinity, y1 = -Infinity, x2 = Infinity, y2 = Infinity
    var p = el.parentElement
    while (p && p !== document.documentElement) {
      var cs = getComputedStyle(p)
      if (cs.overflow !== 'visible' || cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
        var r = p.getBoundingClientRect()
        if (p.clientHeight < 4 || p.clientWidth < 4) return null // collapsed
        x1 = Math.max(x1, r.left); y1 = Math.max(y1, r.top)
        x2 = Math.min(x2, r.right); y2 = Math.min(y2, r.bottom)
      }
      p = p.parentElement
    }
    return { left: x1, top: y1, right: x2, bottom: y2 }
  }

  function clamp(rect, box) {
    if (!box) return null
    var left = Math.max(rect.left, box.left)
    var top = Math.max(rect.top, box.top)
    var right = Math.min(rect.right, box.right)
    var bottom = Math.min(rect.bottom, box.bottom)
    if (right - left <= 1 || bottom - top <= 1) return null
    return { left: left, top: top, right: right, bottom: bottom }
  }

  function visibleRects(el) {
    // getClientRects, not getBoundingClientRect — guard 5. Each entry is one
    // line box for a wrapped inline, so consecutive spans no longer collide.
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return []
    var box = clipBox(el)
    if (!box) return []
    var out = []
    var rects = el.getClientRects()
    for (var i = 0; i < rects.length; i++) {
      var c = clamp(rects[i], box)
      if (c && c.right - c.left > 2 && c.bottom - c.top > 2) out.push(c)
    }
    return out
  }

  function commonAncestor(a, b) {
    var seen = new Set()
    for (var p = a; p; p = p.parentElement) seen.add(p)
    for (var q = b; q; q = q.parentElement) if (seen.has(q)) return q
    return document.body
  }

  function opaqueInFront(a, b, cx, cy) {
    // Guard 6. Whatever is painted at the overlap centre wins; if it is one of
    // the pair and something between it and the pair's COMMON ANCESTOR paints
    // an opaque fill, it is covering the other rather than colliding with it.
    //
    // Stopping at the common ancestor is the whole trick, and getting it wrong
    // was a real bug: walking to <body> always finds an opaque background
    // eventually — the page's own — and that one sits behind BOTH elements, so
    // it says nothing about which is covering which. Unbounded, this guard
    // suppressed genuine collisions.
    if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) return false
    var hit = document.elementFromPoint(cx, cy)
    if (!hit) return false
    var front = a.contains(hit) || hit === a ? a : (b.contains(hit) || hit === b ? b : null)
    if (!front) return true // something else entirely is on top — not our business
    var stop = commonAncestor(a, b)
    var p = front
    while (p && p !== stop) {
      var bg = getComputedStyle(p).backgroundColor
      var m = /rgba?\(([^)]+)\)/.exec(bg)
      if (m) {
        var parts = m[1].split(',').map(parseFloat)
        if (parts.length < 4 || parts[3] > 0.85) return true
      }
      p = p.parentElement
    }
    return false
  }

  function label(el) {
    var t = (el.textContent || '').trim().replace(/\s+/g, ' ')
    return t.length > 34 ? t.slice(0, 34) + '…' : t
  }

  function where(el) {
    var bits = [el.tagName.toLowerCase()]
    if (el.id) bits.push('#' + el.id)
    var cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2)
    if (cls.length) bits.push('.' + cls.join('.'))
    return bits.join('')
  }

  function scanViewport(found, seen, opts) {
    var els = []
    var all = document.querySelectorAll(TEXT_SEL)
    for (var i = 0; i < all.length; i++) {
      var el = all[i]
      if (!isTextLeaf(el)) continue
      if (opts.ignore && el.closest(opts.ignore)) continue
      var rects = visibleRects(el)
      if (!rects.length) continue
      // only what is on screen right now — elementFromPoint needs it, and the
      // scroll pass will reach the rest
      var on = rects.filter(function (r) { return r.bottom > 0 && r.top < innerHeight })
      if (on.length) els.push({ el: el, rects: on })
    }

    var cw = document.documentElement.clientWidth
    for (var a = 0; a < els.length; a++) {
      // right-edge spill
      for (var s = 0; s < els[a].rects.length; s++) {
        if (els[a].rects[s].right > cw + 1) {
          var kSpill = 'spill|' + where(els[a].el) + '|' + label(els[a].el)
          if (!seen[kSpill]) {
            seen[kSpill] = 1
            found.push({ type: 'spills past right edge', text: label(els[a].el), el: els[a].el, detail: Math.round(els[a].rects[s].right - cw) + 'px' })
          }
        }
      }
      for (var b = a + 1; b < els.length; b++) {
        var A = els[a], B = els[b]
        if (A.el.contains(B.el) || B.el.contains(A.el)) continue
        for (var m = 0; m < A.rects.length; m++) {
          for (var n = 0; n < B.rects.length; n++) {
            var ra = A.rects[m], rb = B.rects[n]
            var ox = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left)
            var oy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top)
            if (ox <= opts.minOverlap || oy <= opts.minOverlap) continue
            var area = ox * oy
            var smallest = Math.min((ra.right - ra.left) * (ra.bottom - ra.top), (rb.right - rb.left) * (rb.bottom - rb.top))
            if (area / smallest < opts.minRatio) continue
            var cx = Math.round(Math.max(ra.left, rb.left) + ox / 2)
            var cy = Math.round(Math.max(ra.top, rb.top) + oy / 2)
            if (opaqueInFront(A.el, B.el, cx, cy)) continue
            // The text is part of the key, not just the selector: `where()`
            // returns bare "p" for an element with no id or class, so keying on
            // selectors alone collapsed every unclassed pair on the page into
            // one entry and reported only the first. Found by planting a
            // collision that never showed up.
            var key = 'ov|' + where(A.el) + '|' + label(A.el) + '|' + where(B.el) + '|' + label(B.el)
            if (seen[key]) continue
            seen[key] = 1
            found.push({
              type: 'text overlaps text',
              text: label(A.el) + '  ×  ' + label(B.el),
              el: A.el, other: B.el,
              detail: Math.round(ox) + '×' + Math.round(oy) + 'px'
            })
          }
        }
      }
    }
  }

  function highlight(found) {
    clear()
    found.forEach(function (f) {
      ;[f.el, f.other].forEach(function (el) {
        if (!el) return
        el.setAttribute('data-' + HILITE, '')
      })
    })
    var st = document.createElement('style')
    st.id = HILITE
    st.textContent =
      '[data-' + HILITE + ']{outline:2px solid #ef4135 !important;outline-offset:1px !important;' +
      'background:rgba(239,65,53,.14) !important}'
    document.head.appendChild(st)
  }

  function clear() {
    var st = document.getElementById(HILITE)
    if (st) st.remove()
    document.querySelectorAll('[data-' + HILITE + ']').forEach(function (el) {
      el.removeAttribute('data-' + HILITE)
    })
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }

  async function layoutAudit(options) {
    var opts = Object.assign({
      scroll: true,
      highlight: true,
      minOverlap: 6,
      minRatio: 0.3,
      // chrome that legitimately floats over content
      ignore: 'nav,[class*="navbar"],[role="dialog"]'
    }, options || {})

    if (document.hidden) {
      console.warn(
        '%clayout-audit: this tab is hidden.',
        'color:#ef4135;font-weight:700',
        '\nIntersectionObserver and rAF are parked, so scroll reveals will never fire and the' +
        '\nresult would be meaningless. Focus the tab and run again.'
      )
      return { aborted: 'document.hidden' }
    }

    var found = [], seen = {}
    var startY = scrollY

    if (opts.scroll) {
      // Walk the page so IntersectionObserver actually fires. This is the whole
      // reason for running in a real browser rather than a preview pane.
      var step = Math.round(innerHeight * 0.75)
      for (var y = 0; y < document.body.scrollHeight; y += step) {
        scrollTo(0, y)
        await sleep(260)          // let reveals start
        await sleep(500)          // and finish — transitions here run 380-760ms
        scanViewport(found, seen, opts)
      }
      scrollTo(0, startY)
      await sleep(200)
    } else {
      scanViewport(found, seen, opts)
    }

    if (opts.highlight && found.length) highlight(found)

    console.log(
      '%clayout-audit%c  ' + innerWidth + '×' + innerHeight + '  ·  ' + found.length + ' finding' + (found.length === 1 ? '' : 's'),
      'background:#193c98;color:#fff;padding:2px 6px;border-radius:3px;font-weight:700',
      'color:inherit'
    )
    if (found.length) {
      console.table(found.map(function (f) {
        return { issue: f.type, what: f.text, size: f.detail, element: where(f.el) }
      }))
      console.log('Highlighted in red on the page. layoutAudit.clear() to remove.')
      console.log('Elements:', found.map(function (f) { return f.el }))
    } else {
      console.log('No overlapping, spilling or clipped text found at this width.')
      console.log('Resize with the device toolbar and run again — this only sees the current width.')
    }
    return found
  }

  layoutAudit.clear = clear
  window.layoutAudit = layoutAudit
})()
