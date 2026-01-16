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

    const signatureBytes = Uint8Array.from(atob(signature), c => c.charCodeAt(0));
    const hmac = await crypto.subtle.sign('HMAC', key, encoder.encode(bodyText));

    return timingSafeEqual(new Uint8Array(hmac), signatureBytes);
}

function timingSafeEqual(a, b) {
    if (a.length !== b.length) return false;
    let result = 0;
    for (let i = 0; i < a.length; i++) {
        result |= a[i] ^ b[i];
    }
    return result === 0;
}
