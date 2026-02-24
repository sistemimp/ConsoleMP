<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

$rootDir = __DIR__;
$baseUrl = (isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off' ? 'https' : 'http')
    . '://' . ($_SERVER['HTTP_HOST'] ?? 'localhost')
    . rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/')), '/');

function parseLatestYml(string $content): array
{
    $result = [
        'version' => null,
        'path' => null,
        'url' => null,
        'releaseDate' => null,
        'productName' => null,
        'name' => null,
        'appName' => null
    ];

    $lines = preg_split('/\r\n|\r|\n/', $content) ?: [];
    foreach ($lines as $line) {
        $trimmed = trim($line);
        if ($result['version'] === null && preg_match('/^version:\s*(.+)$/i', $trimmed, $m)) {
            $result['version'] = trim($m[1], " \t\n\r\0\x0B'\"");
            continue;
        }
        if ($result['path'] === null && preg_match('/^path:\s*(.+)$/i', $trimmed, $m)) {
            $result['path'] = trim($m[1], " \t\n\r\0\x0B'\"");
            continue;
        }
        if ($result['url'] === null && preg_match('/^-?\s*url:\s*(.+)$/i', $trimmed, $m)) {
            $result['url'] = trim($m[1], " \t\n\r\0\x0B'\"");
            continue;
        }
        if ($result['releaseDate'] === null && preg_match('/^releaseDate:\s*(.+)$/i', $trimmed, $m)) {
            $result['releaseDate'] = trim($m[1], " \t\n\r\0\x0B'\"");
            continue;
        }
        if ($result['productName'] === null && preg_match('/^productName:\s*(.+)$/i', $trimmed, $m)) {
            $result['productName'] = trim($m[1], " \t\n\r\0\x0B'\"");
            continue;
        }
        if ($result['name'] === null && preg_match('/^name:\s*(.+)$/i', $trimmed, $m)) {
            $result['name'] = trim($m[1], " \t\n\r\0\x0B'\"");
            continue;
        }
        if ($result['appName'] === null && preg_match('/^appName:\s*(.+)$/i', $trimmed, $m)) {
            $result['appName'] = trim($m[1], " \t\n\r\0\x0B'\"");
            continue;
        }
    }

    return $result;
}

function firstExeInFolder(string $folderPath): ?string
{
    $entries = @scandir($folderPath);
    if (!$entries) {
        return null;
    }

    foreach ($entries as $entry) {
        if ($entry === '.' || $entry === '..') {
            continue;
        }
        $full = $folderPath . DIRECTORY_SEPARATOR . $entry;
        if (is_file($full) && preg_match('/\.exe$/i', $entry)) {
            return $entry;
        }
    }

    return null;
}

$folders = [];
$entries = @scandir($rootDir);
if ($entries) {
    foreach ($entries as $entry) {
        if ($entry === '.' || $entry === '..') {
            continue;
        }
        $folderPath = $rootDir . DIRECTORY_SEPARATOR . $entry;
        if (!is_dir($folderPath)) {
            continue;
        }

        $latestPath = $folderPath . DIRECTORY_SEPARATOR . 'latest.yml';
        if (!is_file($latestPath)) {
            continue;
        }

        $latestContent = @file_get_contents($latestPath);
        if ($latestContent === false) {
            continue;
        }

        $latest = parseLatestYml($latestContent);
        $folderUrl = $baseUrl . '/' . rawurlencode($entry);
        $installer = $latest['path'] ?: ($latest['url'] ?: firstExeInFolder($folderPath));
        $derivedName = $latest['productName'] ?: ($latest['appName'] ?: $latest['name']);
        if ($derivedName === null && $installer !== null) {
            $fileName = basename($installer);
            $derivedName = preg_replace('/\.exe$/i', '', $fileName);
        }
        if ($derivedName === null) {
            $derivedName = $entry;
        }

        $folders[] = [
            'name' => $entry,
            'folderUrl' => $folderUrl,
            'indexUrl' => $folderUrl . '/index.html',
            'installerUrl' => $installer ? ($folderUrl . '/' . ltrim($installer, '/')) : null,
            'latest' => [
                'version' => $latest['version'],
                'releaseDate' => $latest['releaseDate'],
                'appName' => $derivedName,
                'productName' => $latest['productName'],
                'name' => $latest['name'],
                'path' => $latest['path'],
                'url' => $latest['url']
            ]
        ];
    }
}

usort($folders, static function (array $a, array $b): int {
    return strcasecmp($a['name'], $b['name']);
});

echo json_encode([
    'ok' => true,
    'generatedAt' => gmdate('c'),
    'baseUrl' => $baseUrl,
    'folders' => $folders
], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
