import { Env } from './types';

type Handler = (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;

export class Router {
    routes: { method: string; pattern: RegExp; handler: Handler }[] = [];

    handle(method: string, pattern: string, handler: Handler) {
        this.routes.push({
            method,
            pattern: new RegExp('^' + pattern.replace(/\*/g, '.*') + '$'),
            handler,
        });
    }

    get(pattern: string, handler: Handler) {
        this.handle('GET', pattern, handler);
    }

    post(pattern: string, handler: Handler) {
        this.handle('POST', pattern, handler);
    }

    delete(pattern: string, handler: Handler) {
        this.handle('DELETE', pattern, handler);
    }

    async resolve(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);
        const path = url.pathname.replace('/api', ''); // Strip /api prefix if present

        for (const route of this.routes) {
            if (request.method === route.method && route.pattern.test(path)) {
                return route.handler(request, env, ctx);
            }
        }

        return new Response('Not Found', { status: 404 });
    }
}
