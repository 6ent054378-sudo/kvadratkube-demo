<?php
/**
 * POST /lead.php — приём заявок с сайта «КвадратВкубе».
 *
 * Кладётся в корень сайта рядом с index.html (работает только на хостинге
 * с PHP, например Beget; на GitHub Pages этот файл не выполняется).
 *
 * Настройки (необязательно) — lead.config.php рядом с этим файлом:
 *   <?php return [
 *     'email' => 'stav.evroremont@yandex.ru',
 *     'telegram_token' => '123456:AA...',
 *     'telegram_chat_id' => '123456789',
 *   ];
 * Файл с токеном в репозиторий не попадает (см. .gitignore).
 * Без конфига заявки уходят письмом на адрес по умолчанию.
 */
declare(strict_types=1);

const LEAD_DEFAULT_EMAIL = 'stav.evroremont@yandex.ru';
const LEAD_MAX_BODY = 16384;

function lead_json(int $code, array $data): void
{
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

function lead_config(): array
{
    $defaults = [
        'email' => LEAD_DEFAULT_EMAIL,
        'telegram_token' => '',
        'telegram_chat_id' => '',
        'dry_run' => false,
    ];
    $file = __DIR__ . '/lead.config.php';
    $cfg = is_file($file) ? (array) require $file : [];
    return array_merge($defaults, $cfg);
}

function lead_str($value, int $max): string
{
    $s = trim((string) $value);
    if (function_exists('mb_substr')) {
        return mb_substr($s, 0, $max);
    }
    return substr($s, 0, $max);
}

/** Проверяет тело заявки. Возвращает [данные, текст ошибки|null]. */
function lead_parse(array $in): array
{
    $data = [
        'source' => lead_str($in['source'] ?? '', 40),
        'name' => lead_str($in['name'] ?? '', 100),
        'phone' => lead_str($in['phone'] ?? '', 30),
        'details' => lead_str($in['details'] ?? '', 2000),
    ];
    if (preg_match_all('/\d/', $data['phone']) < 10) {
        return [$data, 'phone'];
    }
    return [$data, null];
}

function lead_text(array $data): string
{
    $lines = ['🔔 Новая заявка с сайта' . ($data['source'] !== '' ? ' (' . $data['source'] . ')' : '')];
    if ($data['name'] !== '') {
        $lines[] = 'Имя: ' . $data['name'];
    }
    $lines[] = 'Тел: ' . $data['phone'];
    if ($data['details'] !== '') {
        $lines[] = '— ' . $data['details'];
    }
    return implode("\n", $lines);
}

function lead_send_telegram(array $cfg, string $text): bool
{
    if ($cfg['telegram_token'] === '' || $cfg['telegram_chat_id'] === '') {
        return false;
    }
    $url = 'https://api.telegram.org/bot' . $cfg['telegram_token'] . '/sendMessage';
    $payload = json_encode([
        'chat_id' => $cfg['telegram_chat_id'],
        'text' => $text,
    ], JSON_UNESCAPED_UNICODE);
    $body = false;
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $payload,
            CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 12,
        ]);
        $body = curl_exec($ch);
        curl_close($ch);
    } else {
        $ctx = stream_context_create(['http' => [
            'method' => 'POST',
            'header' => "Content-Type: application/json\r\n",
            'content' => $payload,
            'timeout' => 12,
            'ignore_errors' => true,
        ]]);
        $body = @file_get_contents($url, false, $ctx);
    }
    if (!is_string($body)) {
        return false;
    }
    $json = json_decode($body, true);
    return is_array($json) && !empty($json['ok']);
}

function lead_send_email(array $cfg, string $text): bool
{
    $to = (string) $cfg['email'];
    if ($to === '') {
        return false;
    }
    $host = $_SERVER['HTTP_HOST'] ?? 'kvadratvkube26.ru';
    $host = preg_replace('/[^a-z0-9.\-]/i', '', $host) ?: 'kvadratvkube26.ru';
    $subject = '=?UTF-8?B?' . base64_encode('Заявка с сайта КвадратВкубе') . '?=';
    $headers = implode("\r\n", [
        'From: Сайт КвадратВкубе <no-reply@' . $host . '>',
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: 8bit',
    ]);
    return @mail($to, $subject, $text, $headers);
}

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    http_response_code(204);
    exit;
}
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    lead_json(405, ['ok' => false, 'error' => 'method']);
}

$raw = file_get_contents('php://input');
if (strlen((string) $raw) > LEAD_MAX_BODY) {
    lead_json(413, ['ok' => false, 'error' => 'too large']);
}
$in = json_decode((string) $raw, true);
if (!is_array($in)) {
    $in = $_POST;
}
if (!empty($in['_hp'])) {
    // Ловушка для ботов: отвечаем «успехом», ничего не отправляя.
    lead_json(200, ['ok' => true]);
}

[$data, $error] = lead_parse((array) $in);
if ($error !== null) {
    lead_json(400, ['ok' => false, 'error' => $error]);
}

$cfg = lead_config();
if (!empty($cfg['dry_run'])) {
    lead_json(200, ['ok' => true, 'dry' => true, 'text' => lead_text($data)]);
}

$text = lead_text($data);
$sent = [];
if (lead_send_telegram($cfg, $text)) {
    $sent[] = 'tg';
}
if (lead_send_email($cfg, $text)) {
    $sent[] = 'mail';
}
if (!$sent) {
    lead_json(502, ['ok' => false, 'error' => 'delivery']);
}
lead_json(200, ['ok' => true, 'via' => $sent]);
