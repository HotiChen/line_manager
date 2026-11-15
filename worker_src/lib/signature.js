import { timingSafeEqual } from './crypto_util.js';

/**
 * LINE Webhook 簽章驗證
 */
export async function verifySignature(request, bodyText, channelSecret) {
    const signature = request.headers.get('x-line-signature');
    if (!signature) return false;

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(channelSecret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );

    // 非法 base64 簽章視為驗證失敗，不可拋出例外（會變成 500）
    let signatureBytes;
    try {
        signatureBytes = Uint8Array.from(atob(signature), c => c.charCodeAt(0));
    } catch {
        return false;
    }
    const hmac = await crypto.subtle.sign('HMAC', key, encoder.encode(bodyText));

    return timingSafeEqual(new Uint8Array(hmac), signatureBytes);
}
