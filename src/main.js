// crew — fan a named task out across a group of local projects, open them as one
// VSCode workspace, or hand the set to Claude Code. Driven by one persistent config.
//
// Zero runtime dependencies — Node built-ins only, including a built-in process-group
// runner for parallel tasks. POSIX (macOS + Linux). See README for the full model.

import { PKG } from './pkg.js';
import { c } from './colors.js';
import { CrewError, fail } from './util.js';
import {
  cmdRun,
  cmdWorkspace,
  cmdClaude,
  cmdList,
  cmdDir,
  cmdGraph,
  cmdConfig,
  cmdPull,
  cmdAdd,
  cmdEdit,
  cmdRemove,
  cmdGuards,
  cmdOverrides,
  cmdCheck,
  help,
} from './commands.js';

// ---------------------------------------------------------------------------
// Arg parsing + dispatch
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const flags = {
    dryRun: false,
    fileless: false,
    yes: false,
    skipGuards: false,
    help: false,
    version: false,
    config: null,
  };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--skip-guards') flags.skipGuards = true;
    else if (a === '--fileless') flags.fileless = true;
    else if (a === '-y' || a === '--yes') flags.yes = true;
    else if (a === '-h' || a === '--help') flags.help = true;
    else if (a === '-v' || a === '--version') flags.version = true;
    else if (a === '--config') {
      flags.config = argv[++i];
      if (flags.config == null) fail('--config requires a path');
    } else if (a.startsWith('--config=')) flags.config = a.slice('--config='.length);
    else if (a.startsWith('-') && a !== '-') fail(`unknown flag: ${a}`);
    else pos.push(a);
  }
  return { flags, pos };
}

async function main() {
  const { flags, pos } = parseArgs(process.argv.slice(2));

  if (flags.version) {
    console.log(PKG.version);
    return;
  }
  const cmd = pos[0];
  if (!cmd || flags.help) {
    help();
    return;
  }
  const rest = pos.slice(1);

  switch (cmd) {
    case 'help':
      help();
      return;
    case 'list':
    case 'ls':
      cmdList(flags);
      return;
    case 'start':
      await cmdRun(flags, 'start', rest);
      return;
    case 'install':
      await cmdRun(flags, 'install', rest);
      return;
    case 'workspace':
    case 'code':
      await cmdWorkspace(flags, rest);
      return;
    case 'claude':
      await cmdClaude(flags, rest);
      return;
    case 'add':
      await cmdAdd(flags);
      return;
    case 'edit':
      await cmdEdit(flags, rest[0]);
      return;
    case 'remove':
    case 'rm':
      await cmdRemove(flags, rest[0]);
      return;
    case 'guards':
      await cmdGuards(flags, rest[0], rest.slice(1));
      return;
    case 'overrides':
    case 'override':
      await cmdOverrides(flags, rest[0], rest.slice(1));
      return;
    case 'dir':
      cmdDir(flags, rest[0]);
      return;
    case 'graph':
      cmdGraph(flags, rest);
      return;
    case 'config':
      cmdConfig(flags, rest[0]);
      return;
    case 'check':
    case 'validate':
    case 'doctor':
      cmdCheck(flags);
      return;
    case 'pull':
      await cmdPull(flags, rest[0]);
      return;
    default:
      console.error(c.red(`crew: unknown command '${cmd}'`) + '\n');
      help();
      process.exitCode = 1;
      return;
  }
}

main().catch((err) => {
  if (err instanceof CrewError) {
    console.error(c.red(`crew: ${err.message}`));
    process.exit(1);
  }
  console.error(c.red(`crew: unexpected error: ${err && err.message ? err.message : err}`));
  process.exit(1);
});
