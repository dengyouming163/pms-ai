import type { WenlvCondition, WenlvEdgeType } from '../../../db/schema/wenlv.js';

/** 边（节点间流转关系） */
export interface WenlvNodeEdge {
  id: string;
  productId: string;
  fromNodeId: string;
  toNodeId: string;
  edgeType: WenlvEdgeType;
  label?: string | null;
  condition?: WenlvCondition | null;
  grants: string[];
  sanDelta: number;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

/** 创建边的输入 */
export interface CreateEdgeInput {
  fromNodeId: string;
  toNodeId: string;
  edgeType: WenlvEdgeType;
  label?: string;
  condition?: WenlvCondition;
  grants?: string[];
  sanDelta?: number;
  sortOrder?: number;
}

/** 更新边的输入 */
export interface UpdateEdgeInput {
  edgeType?: WenlvEdgeType;
  label?: string | null;
  condition?: WenlvCondition | null;
  grants?: string[];
  sanDelta?: number;
  sortOrder?: number;
}
