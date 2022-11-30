import browser, { Tabs } from 'webextension-polyfill';

export const getCurrentTab = () => {
	return browser.tabs
		.query({
			currentWindow: true,
			active: true,
		})
		.then((tab) => tab[0]);
};

// 获取当前tab页
export const getCurrentTabId = () =>
	getCurrentTab().then((tab) => {
		const tabId = tab.id;
		return tabId !== undefined ? tabId : Promise.reject(new Error('Invalid tab id'));
	});

// 获取所有tab页
export const getAllTabs = () =>
	browser.tabs
		.query({})
		.then(
			(tabs): (Tabs.Tab & { id: number })[] =>
				tabs.filter((tab) => tab.id !== undefined) as any,
		);
