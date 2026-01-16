export function jsonResponse(data: any, status = 200): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
        },
    });
}

export function errorResponse(message: string, status = 400): Response {
    return jsonResponse({ success: false, error: message }, status);
}

export function successResponse(data: any = null): Response {
    return jsonResponse({ success: true, ...(data ? { data } : {}) });
}
