// Opening a folder in the system's file manager from the hooks module: Finder
// on macOS, the desktop's own through `xdg-open` on Linux, Explorer on Windows
// and under WSL. The engine starts a command with its window hidden, and
// Explorer started so opens the folder in a window it never shows; a window a
// background process opens also stays behind the app, out of sight. So Explorer
// opens through a PowerShell script that starts it through the shell, which
// shows it, waits for it, and brings it to the front.

import type { EngineInterface } from 'claude-code'

/** Where Windows keeps its PowerShell, as WSL mounts it: for a PATH that leaves Windows out. */
const WSL_POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'

/**
 * Shows `folder` in the system's file manager; rejects with the reason, in
 * words, when it cannot.
 */
export async function showFolder($: EngineInterface, folder: string): Promise<void> {
  if ((await $.env.get('OS')) === 'Windows_NT') {
    return explorer($, ['powershell.exe'], folder.replace(/\//g, '\\'), {})
  }
  const system = (await $.process.run(['uname', '-sr'])).stdout.trim()
  if (system.startsWith('Darwin')) return opened($, 'open', folder)
  // WSL's kernel names Microsoft: Explorer, on the folder as Windows reaches it.
  if (/microsoft/i.test(system)) {
    const converted = await $.process.run(['wslpath', '-w', folder])
    const path = converted.stdout.trim()
    if (converted.exitCode !== 0 || path === '') {
      throw new Error(converted.stderr.trim() || 'wslpath could not give its Windows path.')
    }
    // A variable crosses to a Windows program only when WSLENV names it.
    const shared = [(await $.env.get('WSLENV')) ?? '', FOLDER_VARIABLE].filter(Boolean).join(':')

    return explorer($, ['powershell.exe', WSL_POWERSHELL], path, { WSLENV: shared })
  }

  return opened($, 'xdg-open', folder)
}

/** Runs the script that shows Explorer, through the first of `programs` that starts. */
async function explorer(
  $: EngineInterface,
  programs: string[],
  path: string,
  env: Record<string, string>,
): Promise<void> {
  const argv = [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    encodedCommand(SHOW_FOLDER_SCRIPT),
  ]
  const init = { env: { ...env, [FOLDER_VARIABLE]: path } }
  for (const [index, program] of programs.entries()) {
    let shown
    try {
      shown = await $.process.run([program, ...argv], init)
    } catch (error) {
      // It could not start: the next, else the reason.
      if (index < programs.length - 1) continue
      throw new Error('Windows PowerShell could not be started.', {
        cause: error,
      })
    }
    if (shown.exitCode === 0) return
    // The script says why on its output, as a line of its own: what PowerShell
    // writes to its error stream, redirected, is XML.
    throw new Error(
      new RegExp(`^${FAILED} (.+)$`, 'm').exec(shown.stdout)?.[1]?.trim() ??
        `PowerShell exited with ${shown.exitCode}.`,
    )
  }
}

/** Opens the folder with a desktop's own opener, `open` or `xdg-open`. */
async function opened($: EngineInterface, opener: string, folder: string): Promise<void> {
  let shown
  try {
    shown = await $.process.run([opener, folder])
  } catch (error) {
    // It could not start, or did not finish in time.
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`${opener} could not be run (${reason}). Is it installed?`, { cause: error })
  }
  if (shown.exitCode !== 0) {
    throw new Error(shown.stderr.trim() || `${opener} exited with ${shown.exitCode}.`)
  }
}

/** The variable the script reads the folder from, so the path is never quoted into it. */
export const FOLDER_VARIABLE = 'DESKTOP_STATUSLINE_FOLDER'
/** What starts the line the script says why it failed on. */
const FAILED = 'FOLDER-NOT-SHOWN:'

/**
 * Shows the folder in Explorer, in front: the window already open on it, else
 * a new one. Windows lets only the foreground's thread raise a window, so the
 * script joins that thread's input for the moment it raises its own. Where
 * PowerShell may not compile that (Constrained Language Mode), the folder
 * still opens, wherever Windows puts it. Explorer is started through the
 * shell, with the folder its one argument: no command line parses the path.
 */
export const SHOW_FOLDER_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'try {',
  `$folder = $env:${FOLDER_VARIABLE}`,
  '$canRaise = $true',
  'try {',
  "Add-Type @'",
  'using System; using System.Runtime.InteropServices;',
  'public static class Front {',
  '  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);',
  '  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();',
  '  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool on);',
  '  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);',
  '  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);',
  '  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);',
  '  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
  '  public static void Raise(IntPtr h) {',
  '    uint them = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);',
  '    uint me = GetCurrentThreadId();',
  '    AttachThreadInput(me, them, true);',
  '    if (IsIconic(h)) ShowWindow(h, 9);',
  '    BringWindowToTop(h);',
  '    SetForegroundWindow(h);',
  '    AttachThreadInput(me, them, false);',
  '  }',
  '}',
  "'@",
  '} catch { $canRaise = $false }',
  '$shell = New-Object -ComObject Shell.Application',
  // A window on the folder, by the folder's own path: its address escapes a
  // space or a `%` its own way. A window on no folder (This PC) is none.
  "$isOn = { param($w) try { $w.Document.Folder.Self.Path -ieq $folder.TrimEnd('\\') } catch { $false } }",
  // Only a shown window: Explorer shows a new one once it has opened the folder,
  // and raising it before then leaves it hidden.
  '$find = { @($shell.Windows()) | Where-Object { (& $isOn $_) -and (-not $canRaise -or [Front]::IsWindowVisible([IntPtr]$_.HWND)) } | Select-Object -Last 1 }',
  '$window = & $find',
  'if (-not $window) {',
  "  $start = New-Object System.Diagnostics.ProcessStartInfo 'explorer.exe'",
  `  $start.Arguments = '"' + $folder + '"'`,
  '  $start.UseShellExecute = $true',
  "  $start.WindowStyle = 'Normal'",
  '  [void][System.Diagnostics.Process]::Start($start)',
  '  for ($i = 0; $i -lt 50 -and -not $window; $i++) { Start-Sleep -Milliseconds 100; $window = & $find }',
  '}',
  'if (-not $window) { throw "Explorer did not open $folder." }',
  'if ($canRaise) { [Front]::Raise([IntPtr]$window.HWND) }',
  `} catch { [Console]::Out.WriteLine('${FAILED} ' + $_.Exception.Message); exit 1 }`,
].join('\n')

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** A script as PowerShell's `-EncodedCommand` takes it: its UTF-16LE bytes in base64. */
export function encodedCommand(script: string): string {
  const bytes: number[] = []
  for (let index = 0; index < script.length; index += 1) {
    const unit = script.charCodeAt(index)
    bytes.push(unit & 0xff, unit >> 8)
  }
  let out = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const [a, b, c] = [bytes[index]!, bytes[index + 1], bytes[index + 2]]
    const word = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += BASE64[(word >> 18) & 63]! + BASE64[(word >> 12) & 63]!
    out += b === undefined ? '=' : BASE64[(word >> 6) & 63]!
    out += c === undefined ? '=' : BASE64[word & 63]!
  }

  return out
}
