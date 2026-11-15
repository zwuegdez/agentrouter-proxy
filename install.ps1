param([switch]$RelayOnly)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$site = 'https://raw.githubusercontent.com/zwuegdez/agentrouter-proxy/v1.2.0'
$appRoot = Join-Path $env:LOCALAPPDATA 'AgentRouterCodexRelay'
$workDir = Join-Path ([IO.Path]::GetTempPath()) ('agentrouter-install-' + [Guid]::NewGuid().ToString('N'))
$userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
function Initialize-PrivateDirectory([string]$Path) {
    if (Test-Path -LiteralPath $Path) {
        $item = Get-Item -LiteralPath $Path -Force
        if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Refusing to install into a symbolic link, junction, or file.' }
    }
    [IO.Directory]::CreateDirectory($Path) | Out-Null
    # Replace explicit grants too: removing inheritance alone can leave broad access.
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($userSid, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}
try {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    $nodeBin = if ($nodeCommand) { $nodeCommand.Source } else { $null }
    $nodeReady = $false
    if ($nodeBin) {
        & $nodeBin -e 'process.exit(Number(process.versions.node.split(String.fromCharCode(46))[0]) >= 22 ? 0 : 1)' 2>$null
        $nodeReady = $LASTEXITCODE -eq 0
    }
    if (-not $nodeReady) { throw 'Node.js 22+ is required. Install it first, then rerun this proxy installer. No proxy, client or runtime was installed.' }
    Initialize-PrivateDirectory $workDir
    Initialize-PrivateDirectory $appRoot
    foreach ($file in @('install.mjs', 'ag.mjs', 'ag-clients.mjs', 'ag-proxy.mjs', 'ag-models.mjs', 'ag-protocols.mjs', 'ag-service.mjs', 'ag-activation.mjs', 'agentrouter-coding-proxy.mjs')) {
        Invoke-WebRequest -UseBasicParsing "$site/$file" -OutFile (Join-Path $workDir $file)
    }
    $nodeArgs = @((Join-Path $workDir 'install.mjs'))
    if ($RelayOnly) { $nodeArgs += '--relay-only' }
    & $nodeBin @nodeArgs
    if ($LASTEXITCODE -ne 0) { throw 'AgentRouter proxy installation did not finish. Follow the message above and retry.' }
} finally {
    if (Test-Path -LiteralPath $workDir) { Remove-Item -LiteralPath $workDir -Recurse -Force }
}
