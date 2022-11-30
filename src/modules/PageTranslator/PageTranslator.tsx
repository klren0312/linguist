import React from 'react';

import { ShadowDOMContainerManager } from '../../lib/ShadowDOMContainerManager';
import { OriginalTextPopup } from '../../layouts/OriginalTextPopup/OriginalTextPopup';

import { NodesTranslator, Config as NodesTranslatorConfig } from '../NodesTranslator';

import { translate } from '../../requests/backend/translate';
import { translateStateUpdate } from './requests';

export type PageTranslateState = {
	resolved: number;
	rejected: number;
	pending: number;
};

function isBlockElement(element: Element) {
	const blockTypes = ['block', 'flex', 'grid', 'table', 'table-row', 'list-item'];
	const display = getComputedStyle(element).display;

	return blockTypes.indexOf(display) !== -1;
}

type PageTranslatorConfig = { originalTextPopup?: boolean };

// TODO: rewrite to augmentation
export class PageTranslator {
	private translateContext = Symbol();
	private pageTranslator: NodesTranslator | null = null;
	// 翻译方向
	private pageTranslateDirection: { from: string; to: string } | null = null;
	// 翻译状态
	private translateState: PageTranslateState = {
		resolved: 0, // 成功
		rejected: 0, // 失败
		pending: 0, // 进行中
	};

	private config: PageTranslatorConfig;
	private nodesTranslatorConfig: NodesTranslatorConfig;
	constructor(config: NodesTranslatorConfig & PageTranslatorConfig) {
		const { originalTextPopup, ...nodesTranslatorConfig } = config;

		this.config = { originalTextPopup };
		this.nodesTranslatorConfig = nodesTranslatorConfig;
	}

	public updateConfig(config: PageTranslatorConfig) {
		this.config = config;
	}

	public isRun() {
		return this.pageTranslator !== null;
	}

	public getStatus() {
		return this.translateState;
	}

	public getTranslateDirection() {
		return this.pageTranslateDirection;
	}

	public run(from: string, to: string) {
		if (this.pageTranslator !== null) {
			throw new Error('Page already translated');
		}

		this.translateContext = Symbol();
		const localContext = this.translateContext;

		// Create local reference to object for decrease risc mutation
		// 创建对象的本地引用, 简化对原变量的修改
		const localTranslateState = this.translateState;
		/**
		 * 翻译文本
		 * @param text 文本
		 * @param priority 优先级
		 * @returns
		 */
		const translateText = async (text: string, priority: number) => {
			if (localContext !== this.translateContext) {
				throw new Error('Outdated context');
			}

			localTranslateState.pending++;
			this.translateStateUpdate();
			console.log('当前需要翻译的文本', text);
			return translate(text, from, to, { priority })
				.then((translatedText) => {
					if (localContext === this.translateContext) {
						localTranslateState.resolved++;
					}

					return translatedText;
				})
				.catch((reason) => {
					if (localContext === this.translateContext) {
						localTranslateState.rejected++;
					}

					throw reason;
				})
				.finally(() => {
					if (localContext === this.translateContext) {
						localTranslateState.pending--;
						this.translateStateUpdate();
					}
				});
		};

		this.pageTranslateDirection = { from, to };
		this.pageTranslator = new NodesTranslator(
			translateText,
			this.nodesTranslatorConfig,
		);
		this.pageTranslator.observe(document.documentElement);

		if (this.config.originalTextPopup) {
			document.addEventListener('mouseover', this.showOriginalTextHandler);
		}
	}

	/**
	 * 停止页面翻译
	 */
	public stop() {
		if (this.pageTranslator === null) {
			throw new Error('Page is not translated');
		}

		this.pageTranslator.unobserve(document.documentElement);
		this.pageTranslator = null;
		this.pageTranslateDirection = null;

		this.translateContext = Symbol();
		this.translateState = {
			resolved: 0,
			rejected: 0,
			pending: 0,
		};
		this.translateStateUpdate();

		if (this.config.originalTextPopup) {
			document.removeEventListener('mouseover', this.showOriginalTextHandler);
			this.shadowRoot.unmountComponent();
		}
	}

	private readonly shadowRoot = new ShadowDOMContainerManager({
		styles: ['common.css', 'contentscript.css'],
	});

	/**
	 * 显示原文弹框
	 * @param evt
	 */
	private showOriginalTextHandler = (evt: MouseEvent) => {
		const target: Element = evt.target as Element;

		// 获取节点的原文
		const getTextOfElement = (element: Node) => {
			let text = '';

			if (element instanceof Text) {
				text += this.pageTranslator?.getNodeData(element)?.originalText ?? '';
			} else if (element instanceof Element) {
				for (const node of Array.from(element.childNodes)) {
					if (node instanceof Text) {
						text +=
							this.pageTranslator?.getNodeData(node)?.originalText ?? '';
					} else if (node instanceof Element && !isBlockElement(node)) {
						text += getTextOfElement(node);
					} else {
						break;
					}
				}
			}

			return text;
		};

		// Create root node
		if (this.shadowRoot.getRootNode() === null) {
			this.shadowRoot.createRootNode();
		}

		// TODO: show popup with text after delay
		const text = getTextOfElement(target);
		if (text) {
			// TODO: consider viewport boundaries
			this.shadowRoot.mountComponent(
				<OriginalTextPopup target={{ current: target as HTMLElement }}>
					{text}
				</OriginalTextPopup>,
			);
		} else {
			this.shadowRoot.unmountComponent();
		}
	};

	/**
	 * 定时更新翻译状态
	 * 减少客户端重绘频率
	 */
	private readonly updateTimeout = 100;
	private lastSentUpdate = 0;
	private timer: number | null = null;
	private translateStateUpdate = () => {
		if (this.timer !== null) return;

		const sendUpdate = () => {
			this.lastSentUpdate = new Date().getTime();
			translateStateUpdate(this.translateState);
		};

		const now = new Date().getTime();
		const idleTime = now - this.lastSentUpdate;
		if (idleTime >= this.updateTimeout) {
			sendUpdate();
		} else {
			this.timer = window.setTimeout(() => {
				this.timer = null;
				sendUpdate();
			}, this.updateTimeout - idleTime);
		}
	};
}
