import type { HydratedDocument, Types } from "mongoose";

export interface IConversation {
  userId: Types.ObjectId;
  title: string;
  activeGenerationId?: Types.ObjectId | null;
  activeLockToken?: string | null;
  lockVersion: number;
  lockExpiresAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export type IConversationDocument = HydratedDocument<IConversation>;