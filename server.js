<?php
declare(strict_types=1);
require_once dirname(__DIR__) . '/init.php';
header('Content-Type: application/json; charset=utf-8');

$user = sp_session_user();
if (!$user) { echo json_encode(['error' => 'Not logged in']); exit; }

$input = json_decode(file_get_contents('php://input'), true);
$matchId = (int)($input['match_id'] ?? 0);
$won = (bool)($input['won'] ?? false);

if (!$matchId) { echo json_encode(['error' => 'Invalid ID']); exit; }

try {
    sp_pdo()->beginTransaction();

    // التحقق من أن اللاعب ليس مطروداً أو غشاشاً (أمان إضافي)
    $stmt = sp_pdo()->prepare("SELECT id, player1_id, player2_id, status FROM matches WHERE id = ? AND (player1_id = ? OR player2_id = ?) FOR UPDATE");
    $stmt->execute([$matchId, $user['id'], $user['id']]);
    $match = $stmt->fetch();

    if ($match && $match['status'] === 'active') {
        // توزيع الجوائز
        if ($won) {
            // الفائز: +250 ZX
            $stmt = sp_pdo()->prepare("UPDATE users SET zx_balance = zx_balance + 250 WHERE id = ?");
            $stmt->execute([$user['id']]);
            
            $stmt = sp_pdo()->prepare("INSERT INTO transactions (user_id, currency_type, amount, balance_after, type, reason) SELECT id, 'zx', 250, zx_balance, 'win', 'Online Match Reward' FROM users WHERE id = ?");
            $stmt->execute([$user['id']]);
        } else {
            // الخاسر: +100 Coins
            $stmt = sp_pdo()->prepare("UPDATE users SET coins = coins + 100 WHERE id = ?");
            $stmt->execute([$user['id']]);
            
            $stmt = sp_pdo()->prepare("INSERT INTO transactions (user_id, currency_type, amount, balance_after, type, reason) SELECT id, 'coins', 100, coins, 'lose', 'Online Match Consolation' FROM users WHERE id = ?");
            $stmt->execute([$user['id']]);
        }

        // إغلاق المباراة وحذفها (لأن اللاعب رأى النتيجة)
        $stmt = sp_pdo()->prepare("UPDATE matches SET status = 'finished', finished_at = NOW() WHERE id = ?");
        $stmt->execute([$matchId]);
    }

    sp_pdo()->commit();
    echo json_encode(['success' => true]);

} catch (Exception $e) {
    if (sp_pdo()->inTransaction()) sp_pdo()->rollBack();
    echo json_encode(['error' => 'Server error']);
}
