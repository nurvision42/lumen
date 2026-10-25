/** Asset table inside the chosen Base. Chinese names are the Feishu column titles. */
export const assetTableName = "素材库";

/** 原始文件 is an attachment (17). Every other column is text (1). */
export const assetFields = [
  { field_name: "名称", type: 1 },
  { field_name: "类型", type: 1 },
  { field_name: "人物", type: 1 },
  { field_name: "服务商", type: 1 },
  { field_name: "账户", type: 1 },
  { field_name: "服务商编号", type: 1 },
  { field_name: "文件指纹", type: 1 },
  { field_name: "原始文件", type: 17 },
  { field_name: "状态", type: 1 },
  { field_name: "备注", type: 1 },
] as const;

export type AssetFieldName = (typeof assetFields)[number]["field_name"];

export function fieldTypeLabel(type: number): string {
  if (type === 1) return "text";
  if (type === 17) return "attachment";
  return String(type);
}
