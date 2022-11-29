import { XMutationObserver } from '../lib/XMutationObserver';

interface NodeData {
	/**
	 * Unique identifier of node
	 */
	id: number;

	/**
	 * With each update of node, this value increase
	 */
	updateId: number;

	/**
	 * Context who contains `updateId` when was translate in last time
	 */
	translateContext: number;

	/**
	 * Original text of node, before translate
	 */
	originalText: string;

	priority: number;
}

/**
 * 查询父节点
 * @param node
 * @param callback
 * @param includeSelf
 * @returns
 */
const searchParent = (
	node: Node,
	callback: (value: Node) => boolean,
	includeSelf = false,
) => {
	// 包含自己就直接返回当前节点
	if (includeSelf && callback(node)) {
		return node;
	}

	// 获取父节点
	let lookingNode: Node | null = node;
	while ((lookingNode = lookingNode.parentNode)) {
		if (callback(lookingNode)) {
			break;
		}
	}
	return lookingNode;
};

/**
 * 遍历指定节点的子节点
 * @param handler if return `false`, loop will stop
 */
const nodeExplore = (
	inputNode: Node,
	nodeFilter: number,
	includeSelf: boolean,
	handler: (value: Node) => void | boolean,
) => {
	// 遍历指定节点下的子节点
	const walk = document.createTreeWalker(inputNode, nodeFilter, null);
	// 包含自己则取当前的, 反之取下一个
	let node = includeSelf ? walk.currentNode : walk.nextNode();
	while (node) {
		if (handler(node) === false) {
			return;
		}
		node = walk.nextNode();
	}
};

/**
 * Check visibility of element in viewport
 * 判断节点是否在当前浏览器可视区域中
 */
export function isInViewport(element: Element, threshold = 0) {
	const { top, left, bottom, right, height, width } = element.getBoundingClientRect();
	const overflows = {
		top,
		left,
		bottom: (window.innerHeight || document.documentElement.clientHeight) - bottom,
		right: (window.innerWidth || document.documentElement.clientWidth) - right,
	};

	if (overflows.top + height * threshold < 0) return false; // 在可视区域的上方
	if (overflows.bottom + height * threshold < 0) return false; // 在可视区域下方

	if (overflows.left + width * threshold < 0) return false; // 在可视区域左边
	if (overflows.right + width * threshold < 0) return false; // 在可视区域右边

	return true;
}

type TranslatorInterface = (text: string, priority: number) => Promise<string>;

interface InnerConfig {
	ignoredTags: Set<string>;
	translatableAttributes: Set<string>;
	lazyTranslate: boolean;
}

export interface Config {
	ignoredTags?: string[];
	translatableAttributes?: string[];
	lazyTranslate?: boolean;
}

// TODO: consider local language definitions (and implement `from`, `to` parameters for translator to specify default or locale languages)
// TODO: scan nodes lazy - defer scan to `requestIdleCallback` instead of instant scan
// TODO: describe nodes life cycle

/**
 * Module for dynamic translate a DOM nodes
 * 动态翻译DOM节点的类
 */
export class NodesTranslator {
	private readonly translateCallback: TranslatorInterface;
	private readonly config: InnerConfig;

	constructor(translateCallback: TranslatorInterface, config?: Config) {
		this.translateCallback = translateCallback;
		this.config = {
			...config,
			ignoredTags: new Set(
				config?.ignoredTags !== undefined
					? config.ignoredTags.filter(String)
					: [],
			), // 忽略的标签
			translatableAttributes: new Set(
				config?.translatableAttributes !== undefined
					? config.translatableAttributes.filter(String)
					: [],
			), // 需要翻译的属性
			// 懒翻译
			lazyTranslate:
				config?.lazyTranslate !== undefined ? config?.lazyTranslate : true,
		};
	}

	// 存储在监听的节点
	private readonly observedNodesStorage = new Map<Element, XMutationObserver>();
	// 监听指定节点变化
	public observe(node: Element) {
		if (this.observedNodesStorage.has(node)) {
			throw new Error('Node already under observe');
		}

		// 监听节点和子节点更改
		const observer = new XMutationObserver();
		this.observedNodesStorage.set(node, observer);

		observer.addHandler('elementAdded', ({ target }) => this.addNode(target)); // 新增节点
		observer.addHandler('elementRemoved', ({ target }) => this.deleteNode(target)); // 移除节点
		observer.addHandler('characterData', ({ target }) => {
			// 文本变化
			this.updateNode(target);
		});
		observer.addHandler('changeAttribute', ({ target, attributeName }) => {
			// 属性变化
			if (attributeName === undefined || attributeName === null) return;
			if (!(target instanceof Element)) return;

			const attribute = target.attributes.getNamedItem(attributeName);

			if (attribute === null) return;

			// NOTE: If need delete untracked nodes, we should keep relates like Element -> attributes
			if (!this.nodeStorage.has(attribute)) {
				this.addNode(attribute);
			} else {
				this.updateNode(attribute);
			}
		});

		observer.observe(node);
		this.addNode(node);
	}

	public unobserve(node: Element) {
		if (!this.observedNodesStorage.has(node)) {
			throw new Error('Node is not under observe');
		}

		this.deleteNode(node);
		this.observedNodesStorage.get(node)?.disconnect();
		this.observedNodesStorage.delete(node);
	}

	// 获取节点的原文数据
	public getNodeData(node: Node) {
		const nodeData = this.nodeStorage.get(node);
		if (nodeData === undefined) return null;

		const { originalText } = nodeData;
		return { originalText };
	}

	// 相交节点存储
	private readonly itersectStorage = new WeakSet<Node>();
	// 监听节点进入指定区域
	private readonly itersectObserver = new IntersectionObserver(
		(entries, observer) => {
			entries.forEach((entry) => {
				const node = entry.target;
				if (!this.itersectStorage.has(node) || !entry.isIntersecting) return;

				this.itersectStorage.delete(node);
				observer.unobserve(node);
				this.intersectNode(node);
			});
		},
		{ root: null, rootMargin: '0px', threshold: 0 },
	);

	private intersectNode = (node: Element) => {
		// Translate child text nodes and attributes of target node
		// WARNING: we shall not touch inner nodes, because its may still not intersected
		// 遍历子节点, 送去处理格式化
		node.childNodes.forEach((node) => {
			if (node instanceof Element || !this.isTranslatableNode(node)) return;
			this.handleNode(node);
		});
	};

	/**
	 * 监听指定节点进入可视区域
	 * @param node
	 * @returns
	 */
	private handleElementByIntersectViewport(node: Element) {
		if (this.itersectStorage.has(node)) return;
		this.itersectStorage.add(node);
		this.itersectObserver.observe(node);
	}

	private idCounter = 0; // 用于生成id
	private nodeStorage = new WeakMap<Node, NodeData>(); // 节点存储
	/**
	 * 处理节点, 存储添加相关属性
	 * @param node
	 * @returns
	 */
	private handleNode = (node: Node) => {
		if (this.nodeStorage.has(node)) return;

		// Skip empthy text
		if (node.nodeValue === null || node.nodeValue.trim().length == 0) return;

		// Skip not translatable nodes
		if (!this.isTranslatableNode(node)) return;

		// 计算翻译优先级
		const priority = this.getNodeScore(node);

		this.nodeStorage.set(node, {
			id: this.idCounter++,
			updateId: 1,
			translateContext: 0,
			originalText: '',
			priority,
		});
		// 送去翻译
		this.translateNode(node);
	};

	// 添加节点
	private addNode(node: Node) {
		// Add all nodes which element contains (text nodes and attributes of current and inner elements)
		if (node instanceof Element) {
			this.handleTree(node, (node) => {
				if (node instanceof Element) return;

				if (this.isTranslatableNode(node)) {
					this.addNode(node);
				}
			});

			return;
		}

		// Handle text nodes and attributes

		// Lazy translate when own element intersect viewport
		// But translate at once if node have not parent (virtual node) or parent node is outside of body (utility tags like meta or title)
		// 只翻译视图中触发的节点
		// 如果节点没有父节点(虚拟节点)或者父节点在body外(例如meta或者title标签), 会直接翻译
		if (this.config.lazyTranslate) {
			const isAttachedToDOM = node.getRootNode() !== node;
			const observableNode =
				node instanceof Attr ? node.ownerElement : node.parentElement;

			// Ignore lazy translation for not intersectable nodes and translate it immediately
			if (
				isAttachedToDOM &&
				observableNode !== null &&
				this.isIntersectableNode(observableNode)
			) {
				this.handleElementByIntersectViewport(observableNode);
				return;
			}
		}

		// Add to storage
		this.handleNode(node);
	}

	/**
	 * 从存储中删除节点, 并取消监听
	 * @param node
	 * @param onlyTarget
	 */
	private deleteNode(node: Node, onlyTarget = false) {
		if (node instanceof Element) {
			// Delete all attributes and inner nodes
			if (!onlyTarget) {
				this.handleTree(node, (node) => {
					this.deleteNode(node, true);
				});
			}

			// 取消相交监听
			this.itersectStorage.delete(node);
			this.itersectObserver.unobserve(node);
		}

		const nodeData = this.nodeStorage.get(node);
		if (nodeData !== undefined) {
			// 复原节点的原文
			node.nodeValue = nodeData.originalText;
			this.nodeStorage.delete(node);
		}
	}

	// Updates never be lazy
	// 更新节点
	private updateNode(node: Node) {
		const nodeData = this.nodeStorage.get(node);
		if (nodeData !== undefined) {
			nodeData.updateId++;
			this.translateNode(node);
		}
	}

	/**
	 * Call only for new and updated nodes
	 * 翻译节点
	 */
	private translateNode(node: Node) {
		const nodeData = this.nodeStorage.get(node);
		if (nodeData === undefined) {
			throw new Error('Node is not register');
		}

		if (node.nodeValue === null) return;

		// Recursion prevention
		// 防止无限递归
		if (nodeData.updateId <= nodeData.translateContext) {
			return;
		}

		const nodeId = nodeData.id;
		const nodeContext = nodeData.updateId;
		// 需要翻译的文本和优先级传给回调
		return this.translateCallback(node.nodeValue, nodeData.priority).then((text) => {
			const actualNodeData = this.nodeStorage.get(node);
			if (actualNodeData === undefined || nodeId !== actualNodeData.id) {
				return;
			}
			if (nodeContext !== actualNodeData.updateId) {
				return;
			}

			// actualNodeData.translateData = text;
			// 把原始文本缓存后 替换当前文本为翻译后文本
			actualNodeData.originalText = node.nodeValue !== null ? node.nodeValue : '';
			actualNodeData.translateContext = actualNodeData.updateId + 1;
			node.nodeValue = text;
			return node;
		});
	}

	/**
	 * 是否是可以翻译的节点
	 * @param targetNode
	 * @returns
	 */
	private isTranslatableNode(targetNode: Node) {
		let targetToParentsCheck: Element | null = null;

		// Check node type and filters for its type
		if (targetNode instanceof Element) {
			// 判断是否在忽略列表里
			if (this.config.ignoredTags.has(targetNode.localName)) {
				return false;
			}

			targetToParentsCheck = targetNode;
		} else if (targetNode instanceof Attr) {
			// 如果是属性字段, 则判断当前属性是否在可翻译列表中
			// 在则取其节点
			if (!this.config.translatableAttributes.has(targetNode.name)) {
				return false;
			}
			targetToParentsCheck = targetNode.ownerElement;
		} else if (targetNode instanceof Text) {
			// 如果是文本, 取父节点
			targetToParentsCheck = targetNode.parentElement;
		} else {
			return false;
		}

		// Check parents to ignore
		if (targetToParentsCheck !== null) {
			const ignoredParent = searchParent(
				targetToParentsCheck,
				(node: Node) =>
					node instanceof Element &&
					this.config.ignoredTags.has(node.localName),
				true,
			);

			if (ignoredParent !== null) {
				return false;
			}
		}

		// We can't proof that node is not translatable
		return true;
	}

	/**
	 * 是否是可视节点
	 * @param node
	 * @returns
	 */
	private isIntersectableNode = (node: Element) => {
		if (node.nodeName === 'OPTION') return false;

		return document.body.contains(node);
	};

	/**
	 * Calculate node priority for translate, the bigger number the importance text
	 * 计算节点翻译优先级
	 */
	private getNodeScore = (node: Node) => {
		let score = 0;

		if (node instanceof Attr) {
			score += 1;
			const parent = node.ownerElement;
			if (parent && isInViewport(parent)) {
				// 可见节点的属性高于不可见节点的文本
				score += 2;
			}
		} else if (node instanceof Text) {
			score += 2;
			const parent = node.parentElement;
			if (parent && isInViewport(parent)) {
				// 可视节点的文本优先级最高
				score += 2;
			}
		}

		return score;
	};

	/**
	 * Handle all translatable nodes from element
	 * Element, Attr, Text
	 * 处理需要翻译的节点
	 */
	private handleTree(node: Element, callback: (node: Node) => void) {
		// NodeFilter.SHOW_ALL 显示所有节点
		nodeExplore(node, NodeFilter.SHOW_ALL, true, (node) => {
			callback(node);

			if (node instanceof Element) {
				// 处理 shadow DOM
				if (node.shadowRoot !== null) {
					for (const child of Array.from(node.shadowRoot.children)) {
						this.handleTree(child, callback);
					}
				}

				// 处理节点的属性
				for (const attribute of Object.values(node.attributes)) {
					callback(attribute);
				}
			}
		});
	}
}
