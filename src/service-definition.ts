interface ServiceRenderInput {
  readonly programArguments: readonly string[];
  readonly workingDirectory: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly standardOutputPath: string;
  readonly standardErrorPath: string;
}

export interface LaunchdServiceRenderInput extends ServiceRenderInput {
  readonly label: string;
}

export interface SystemdServiceRenderInput extends ServiceRenderInput {
  readonly wantedBy: 'default.target' | 'multi-user.target';
}

function assertServiceValue(value: string): void {
  if (value.includes('\0') || value.includes('\n') || value.includes('\r')) {
    throw new Error('Service definition values must not contain control characters');
  }
}

function xml(value: string): string {
  assertServiceValue(value);
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function systemdWord(value: string): string {
  assertServiceValue(value);
  const escaped = value.replaceAll('%', '%%');
  if (/^[A-Za-z0-9_./:@+=,-]+$/u.test(escaped)) return escaped;
  return `"${escaped.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$')}"`;
}

export function renderLaunchdService(input: LaunchdServiceRenderInput): string {
  const argumentsXml = input.programArguments.map((argument) => `        <string>${xml(argument)}</string>`).join('\n');
  const environmentXml = Object.entries(input.environment)
    .map(([key, value]) => `        <key>${xml(key)}</key>\n        <string>${xml(value)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${xml(input.label)}</string>
    <key>ProgramArguments</key>
    <array>
${argumentsXml}
    </array>
    <key>WorkingDirectory</key>
    <string>${xml(input.workingDirectory)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
${environmentXml}
    </dict>
    <key>StandardOutPath</key>
    <string>${xml(input.standardOutputPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(input.standardErrorPath)}</string>
</dict>
</plist>`;
}

export function renderSystemdService(input: SystemdServiceRenderInput): string {
  const environment = Object.entries(input.environment)
    .map(([key, value]) => `Environment=${systemdWord(`${key}=${value}`)}`)
    .join('\n');
  return `[Unit]
Description=NanoClaw Personal Assistant
After=network.target

[Service]
Type=simple
ExecStart=${input.programArguments.map(systemdWord).join(' ')}
WorkingDirectory=${systemdWord(input.workingDirectory)}
Restart=always
RestartSec=5
KillMode=process
${environment}
StandardOutput=${systemdWord(`append:${input.standardOutputPath}`)}
StandardError=${systemdWord(`append:${input.standardErrorPath}`)}

[Install]
WantedBy=${input.wantedBy}`;
}
