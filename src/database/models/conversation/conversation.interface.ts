import type { HydratedDocument, Types } from "mongoose";

export interface IConversation {
  userId: Types.ObjectId;
  title: string;
}

export type IConversationDocument = HydratedDocument<IConversation>;