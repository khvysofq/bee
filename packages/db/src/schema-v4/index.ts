/**
 * v4 schema barrel：9 张表，品类为轴。
 *
 * 与旧 25 表 schema 并存（线上仍用旧 schema），入口通过
 * `export * as v4 from './schema-v4'` 暴露，避免同名冲突。
 */
export * from './catalog';
export * from './price';
export * from './content';
export * from './ops';