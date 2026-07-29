import { c, projectColors } from './colors.js';
import { canInteractive, menu } from './prompt.js';
import { dependencyEdges, connectivityStatus } from './wiring.js';
import { loadLastSelection, saveLastSelection, membersFor } from './config.js';
import { fail } from './util.js';

// ---------------------------------------------------------------------------
// Selection — a set of projects chosen per-run, picked interactively (preselected with the
// last selection). No groups; the remembered selection replaces them.
// ---------------------------------------------------------------------------
// Open the multiselect picker (preselected with the remembered selection) and return the
// chosen members, or null if cancelled / nothing chosen. Selection is ALWAYS interactive —
// projects are never named on the CLI. Persists the chosen set globally. opts.connectivity
// adds the live wiring-connectivity footer (for co-running sets).
export async function selectMembers(flags, cfg, opts = {}) {
  const known = Object.keys(cfg.projects || {});
  if (!known.length) fail('no projects configured yet — run: crew add');
  if (!canInteractive()) fail('crew needs an interactive terminal to pick projects');
  const paint = projectColors(cfg);
  // Precompute the graph once so the live footer is a pure in-memory lookup per keypress.
  const edges = opts.connectivity ? dependencyEdges(cfg, Object.entries(cfg.projects)) : null;
  const picked = await menu({
    title: 'Select projects',
    items: known,
    multi: true,
    preselected: loadLastSelection(flags).filter((n) => cfg.projects[n]),
    label: (o, cur) => (cur ? c.bold(paint.get(o)(o)) : paint.get(o)(o)),
    footer: edges ? (sel) => connectivityStatus(cfg, edges, sel, true) : null,
  });
  if (!picked || !picked.length) {
    console.log(c.dim('nothing selected'));
    return null;
  }
  saveLastSelection(flags, picked);
  return membersFor(cfg, picked);
}
