import browser, { Runtime } from 'webextension-polyfill';

type RequestHandler = (data: any, sender: Runtime.MessageSender) => void | Promise<any>;

/**
 * Add handler for browser requests in current context (background or content script)
 * 当前上下文(background或content脚本中)添加浏览器请求处理
 * @returns cleanup function which remove listener
 */
export function addRequestHandler(action: string, handler: RequestHandler) {
	// Wrapper which handle only messages for this endpoint
	const wrapper = (message: any, sender: Runtime.MessageSender) => {
		if (!(message instanceof Object) || message.action !== action) return;

		return handler(message.data, sender);
	};

	// Registry listener
	browser.runtime.onMessage.addListener(wrapper);

	// Return cleanup hook
	const cleanup = () => browser.runtime.onMessage.removeListener(wrapper);
	return cleanup;
}

/**
 * Send request to background scripts
 *发送请求到 background
 * It may be `background.ts`, popup or settings
 */
export function sendBackgroundRequest(action: string, data?: any) {
	return browser.runtime.sendMessage({ action, data });
}

/**
 * Send request to tab
 * 发送请求到tab
 */
export function sendTabRequest(tabId: number, action: string, data?: any) {
	return browser.tabs.sendMessage(tabId, { action, data });
}
