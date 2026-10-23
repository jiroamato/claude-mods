import type { EngineInterface } from 'claude-code'

const WSL_POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'

export async function showFolder($: EngineInterface, folder: string): Promise<void> {
  if ((await $.env.get('OS')) === 'Windows_NT') {
    return explorer($, ['powershell.exe'], folder.replace(/\//g, '\\'), {})
  }
  const system = (await $.process.run(['uname', '-sr'])).stdout.trim()
  if (system.startsWith('Darwin')) return opened($, 'open', folder)
  if (/microsoft/i.test(system)) {
    const converted = await $.process.run(['wslpath', '-w', folder])
    const path = converted.stdout.trim()
    if (converted.exitCode !== 0 || path === '') {
      throw new Error(converted.stderr.trim() || 'wslpath could not give its Windows path.')
    }
    const shared = [(await $.env.get('WSLENV')) ?? '', FOLDER_VARIABLE].filter(Boolean).join(':')

    return explorer($, ['powershell.exe', WSL_POWERSHELL], path, { WSLENV: shared })
  }

  return opened($, 'xdg-open', folder)
}

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
      if (index < programs.length - 1) continue
      throw new Error('Windows PowerShell could not be started.', {
        cause: error,
      })
    }
    if (shown.exitCode === 0) return
    throw new Error(
      new RegExp(`^${FAILED} (.+)$`, 'm').exec(shown.stdout)?.[1]?.trim() ??
        `PowerShell exited with ${shown.exitCode}.`,
    )
  }
}

async function opened($: EngineInterface, opener: string, folder: string): Promise<void> {
  let shown
  try {
    shown = await $.process.run([opener, folder])
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`${opener} could not be run (${reason}). Is it installed?`, { cause: error })
  }
  if (shown.exitCode !== 0) {
    throw new Error(shown.stderr.trim() || `${opener} exited with ${shown.exitCode}.`)
  }
}

export const FOLDER_VARIABLE = 'DESKTOP_STATUSLINE_FOLDER'
const FAILED = 'FOLDER-NOT-SHOWN:'

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
  "$isOn = { param($w) try { $w.Document.Folder.Self.Path -ieq $folder.TrimEnd('\\') } catch { $false } }",
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
