import type { GatewaySnapshot, GatewayUpdate, ModelPriceCatalogSnapshot } from './contracts'

/** 价格目录按版本传输；捕获每次调用的旧目录，避免交错响应拼接不同版本。 */
export function createGatewayReader(invoke: (version?: number) => Promise<GatewayUpdate>) {
  let cached: { version: number; catalog: ModelPriceCatalogSnapshot } | undefined
  return async (): Promise<GatewaySnapshot> => {
    const previous = cached
    const { catalogVersion, modelPriceCatalog, ...state } = await invoke(previous?.version)
    const catalog =
      modelPriceCatalog ?? (previous?.version === catalogVersion ? previous.catalog : undefined)
    if (!catalog) throw new Error('模型价格目录版本已变化，请刷新重试')
    if (!cached || catalogVersion >= cached.version) cached = { version: catalogVersion, catalog }
    return { ...state, modelPriceCatalog: catalog }
  }
}
