import mongoose, { Schema, Document } from 'mongoose';

export interface IMockTradeRecrod extends Document {
  taskId: string;
  side: string;
  proxyWallet: string;
  asset: string;
  conditionId: string;
  outcomeIndex?: number;
  fillPrice: number;
  fillSize: number;
  usdcAmount: number;
  slippage: number;
  costBasisPrice?: number;
  soldCost?: number;
  realizedPnl?: number;
  positionSizeBefore?: number;
  positionSizeAfter?: number;
  sourceActivityId?: mongoose.Types.ObjectId;
  sourceTransactionHash?: string;
  sourceTimestamp?: number;
  executedAt: number;
  title?: string;
  slug?: string;
  eventSlug?: string;
  outcome?: string;
}

const MockTradeRecrodSchema: Schema = new Schema({
  taskId: { type: String, required: true, index: true },
  side: { type: String, required: true },
  proxyWallet: { type: String, required: true, index: true },
  asset: { type: String, required: true },
  conditionId: { type: String, required: true, index: true },
  outcomeIndex: { type: Number },
  fillPrice: { type: Number, required: true },
  fillSize: { type: Number, required: true },
  usdcAmount: { type: Number, required: true },
  slippage: { type: Number, required: true },
  costBasisPrice: { type: Number },
  soldCost: { type: Number },
  realizedPnl: { type: Number },
  positionSizeBefore: { type: Number },
  positionSizeAfter: { type: Number },
  sourceActivityId: { type: Schema.Types.ObjectId, ref: 'UserActivity' },
  sourceTransactionHash: { type: String },
  sourceTimestamp: { type: Number },
  executedAt: { type: Number, required: true },
  title: { type: String },
  slug: { type: String },
  eventSlug: { type: String },
  outcome: { type: String },
});

export const mockTradeRecrod = mongoose.model<IMockTradeRecrod>(
  'mockTradeRecrod',
  MockTradeRecrodSchema
);
