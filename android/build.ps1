param(
    [string]$SdkRoot = $env:ANDROID_HOME,
    [string]$ZxingJar
)

$ErrorActionPreference = 'Stop'
if (!$SdkRoot) { $SdkRoot = $env:ANDROID_SDK_ROOT }
if (!$SdkRoot) { $SdkRoot = Join-Path $env:LOCALAPPDATA 'Android/Sdk' }

function Run-Tool([string]$Program, [string[]]$Arguments) {
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program exited with code $LASTEXITCODE" }
}

$tools = Join-Path $SdkRoot 'build-tools/36.0.0'
$platform = Join-Path $SdkRoot 'platforms/android-36/android.jar'
if (!(Test-Path -LiteralPath $platform) -or !(Test-Path -LiteralPath (Join-Path $tools 'aapt2.exe'))) {
    throw 'Install Android SDK Platform 36 and Build Tools 36.0.0, then set ANDROID_HOME or pass -SdkRoot.'
}

$output = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'out'))
New-Item -ItemType Directory -Force -Path $output | Out-Null
if ((Get-Item -LiteralPath $output).Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'Android build output must be an ordinary directory.'
}
$expectedZxing = '71DE5D89341B5FCF5DD89DA7F44E84D825D0E084CDF3EC77C9ABE26B0F0CEB13'
if (!$ZxingJar) {
    $ZxingJar = Join-Path $output 'zxing-core-3.5.4.jar'
    if (!(Test-Path -LiteralPath $ZxingJar)) {
        $url = 'https://repo.maven.apache.org/maven2/com/google/zxing/core/3.5.4/core-3.5.4.jar'
        $download = Join-Path $output ('zxing-' + [guid]::NewGuid().ToString('N') + '.tmp')
        try {
            Run-Tool 'curl.exe' @('--fail', '--silent', '--show-error', '--location', '--max-time', '60', $url, '-o', $download)
            if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash -ne $expectedZxing) {
                throw 'The downloaded ZXing artifact does not match the pinned SHA-256.'
            }
            Move-Item -LiteralPath $download -Destination $ZxingJar -Force
        } finally {
            if (Test-Path -LiteralPath $download) { Remove-Item -LiteralPath $download -Force }
        }
    }
}
$ZxingJar = (Resolve-Path -LiteralPath $ZxingJar).Path
if ((Get-FileHash -LiteralPath $ZxingJar -Algorithm SHA256).Hash -ne $expectedZxing) {
    throw 'ZXing Core 3.5.4 does not match the pinned Maven Central SHA-256.'
}

$scratch = [IO.Path]::GetFullPath((Join-Path $output ([guid]::NewGuid().ToString('N'))))
if (!$scratch.StartsWith("$output\", [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Android build intermediates must stay within android/out.'
}
$source = Join-Path $PSScriptRoot 'src/main'
$generated = Join-Path $scratch 'generated'
$classes = Join-Path $scratch 'classes'
$dex = Join-Path $scratch 'dex'
$assets = Join-Path $scratch 'assets'
$resources = Join-Path $scratch 'resources.zip'
$unsigned = Join-Path $scratch 'unsigned.apk'
$aligned = Join-Path $scratch 'aligned.apk'
$signed = Join-Path $scratch 'Glove-Companion.apk'
$classJar = Join-Path $scratch 'classes.jar'
$key = Join-Path $output '.preview-signing.p12'

try {
    New-Item -ItemType Directory -Force -Path $generated,$classes,$dex,$assets | Out-Null
    Copy-Item -LiteralPath (Join-Path $source 'assets/licenses/ZXing-Apache-2.0.txt') -Destination $assets
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../LICENSE') -Destination (Join-Path $assets 'Glove-MIT.txt')
    Run-Tool (Join-Path $tools 'aapt2.exe') @('compile', '--dir', (Join-Path $source 'res'), '-o', $resources)
    Run-Tool (Join-Path $tools 'aapt2.exe') @(
        'link', '-I', $platform, '--manifest', (Join-Path $source 'AndroidManifest.xml'),
        '--java', $generated, '-A', $assets, '-o', $unsigned, $resources
    )
    $javaSources = @(Get-ChildItem -LiteralPath (Join-Path $source 'java'),$generated -Recurse -File -Filter '*.java' |
        ForEach-Object FullName)
    Run-Tool 'javac.exe' (@('-encoding', 'UTF-8', '--release', '17', '-classpath', "$platform;$ZxingJar", '-d', $classes) + $javaSources)
    Run-Tool 'jar.exe' @('cf', $classJar, '-C', $classes, '.')
    Run-Tool (Join-Path $tools 'd8.bat') @('--release', '--lib', $platform, '--min-api', '30', '--output', $dex, $classJar, $ZxingJar)
    Run-Tool 'jar.exe' @('uf', $unsigned, '-C', $dex, 'classes.dex')
    Run-Tool (Join-Path $tools 'zipalign.exe') @('-f', '4', $unsigned, $aligned)
    if (!(Test-Path -LiteralPath $key)) {
        Run-Tool 'keytool.exe' @(
            '-genkeypair', '-storetype', 'PKCS12', '-keystore', $key, '-storepass', 'android',
            '-keypass', 'android', '-alias', 'glove-preview', '-keyalg', 'RSA', '-keysize', '3072',
            '-validity', '3650', '-dname', 'CN=Glove Local Preview'
        )
    }
    Run-Tool (Join-Path $tools 'apksigner.bat') @(
        'sign', '--ks', $key, '--ks-key-alias', 'glove-preview', '--ks-pass', 'pass:android',
        '--key-pass', 'pass:android', '--out', $signed, $aligned
    )
    Run-Tool (Join-Path $tools 'apksigner.bat') @('verify', '--verbose', $signed)
    $artifact = Join-Path $output 'Glove-Companion.apk'
    Move-Item -LiteralPath $signed -Destination $artifact -Force
    Get-FileHash -LiteralPath $artifact -Algorithm SHA256
} finally {
    if (Test-Path -LiteralPath $scratch) {
        Remove-Item -LiteralPath $scratch -Recurse -Force
    }
}
