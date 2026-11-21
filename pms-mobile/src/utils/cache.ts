interface CacheItem {
	data: any
	timestamp: number
	ttl: number
}

const cacheStore = new Map<string, CacheItem>()

const DEFAULT_TTL = 5 * 60 * 1000

export function setCache(key: string, data: any, ttl: number = DEFAULT_TTL): void {
	cacheStore.set(key, {
		data,
		timestamp: Date.now(),
		ttl
	})
}

export function getCache(key: string): any | null {
	const item = cacheStore.get(key)
	if (!item) return null
	
	if (Date.now() - item.timestamp < item.ttl) {
		return item.data
	}
	
	cacheStore.delete(key)
	return null
}

export function clearCache(key?: string): void {
	if (key) {
		cacheStore.delete(key)
	} else {
		cacheStore.clear()
	}
}

export function hasCache(key: string): boolean {
	const item = cacheStore.get(key)
	if (!item) return false
	return Date.now() - item.timestamp < item.ttl
}

export function getCacheKeys(): string[] {
	return Array.from(cacheStore.keys())
}
