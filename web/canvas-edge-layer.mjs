/** Keep SVG hit targets and visible paths stable while the nodes move. */
export function createEdgeLayer(layer, svgElement, selectEdge) {
  const paths = new Map();
  let order = [];
  let draft = null;
  layer.addEventListener('click', event => {
    const id = event.target.dataset.edgeId;
    if (!paths.has(id)) return;
    event.stopPropagation();
    selectEdge(id);
  });

  function setDraft(curve) {
    if (!curve) {
      draft?.remove();
      draft = null;
      return;
    }
    if (!draft) {
      draft = svgElement('path', { class: 'edge-draft' });
      layer.append(draft);
    }
    if (draft.getAttribute('d') !== curve) draft.setAttribute('d', curve);
  }

  function update(edges, selected, draftCurve) {
    const reordered = edges.length !== order.length || edges.some((edge, i) => edge.id !== order[i]);
    for (const { id, curve } of edges) {
      let pair = paths.get(id);
      if (!pair) {
        pair = {
          hit: svgElement('path', { class: 'edge-hit', 'data-edge-id': id }),
          line: svgElement('path', { class: 'edge-line' }),
          curve: null, selected: false,
        };
        paths.set(id, pair);
      }
      if (pair.curve !== curve) {
        pair.hit.setAttribute('d', curve);
        pair.line.setAttribute('d', curve);
        pair.curve = curve;
      }
      if (pair.selected !== (id === selected)) {
        pair.selected = id === selected;
        pair.line.classList.toggle('edge-selected', pair.selected);
      }
    }
    if (reordered) {
      order = edges.map(edge => edge.id);
      const live = new Set(order);
      for (const id of paths.keys()) if (!live.has(id)) paths.delete(id);
      const children = order.flatMap(id => [paths.get(id).hit, paths.get(id).line]);
      if (draft) children.push(draft);
      layer.replaceChildren(...children);
    }
    setDraft(draftCurve);
  }
  return { update, setDraft };
}
