// The one place that reaches into McpServer's registrations. `pnpm test:usage` pins
// both functions against the installed SDK with a real dispatch.

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/server';

// McpServer has no public way to enumerate what was registered, so this reads the
// private map. A rename in the SDK makes this return undefined, which the usage test
// reports as a failure rather than as a server that silently counts nothing.
export function registeredTools(server: McpServer): Record<string, RegisteredTool> {
	return (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
		._registeredTools;
}

type AnyHandler = (...args: never[]) => unknown;
type Callback = NonNullable<Parameters<RegisteredTool['update']>[0]['callback']>;

// Replace one tool's handler. SDK 2 dispatches through `executor`, which it builds
// from the handler at registration, so assigning `tool.handler` is a no-op there.
// `update({ callback })` is the public route and rebuilds the executor. It also
// sends `list_changed`, but only on a connected server, so call this before
// `connect`. The wrapper must return what the handler returned; the cast is what
// lets it be typed loosely.
export function wrapToolHandler(
	tool: RegisteredTool,
	wrap: (handler: AnyHandler) => AnyHandler
): void {
	const handler = tool.handler.bind(tool) as unknown as AnyHandler;
	tool.update({ callback: wrap(handler) as unknown as Callback });
}
