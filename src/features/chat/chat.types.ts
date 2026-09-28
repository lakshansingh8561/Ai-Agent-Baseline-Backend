export interface SafeConversation {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface MessageAttachment {
  type: "image";
  url: string;
  publicId?: string;
  mimeType: string;
  name: string;
  size: number;
}

export type MessageStatus = "pending" | "generating" | "completed" | "failed";

export interface SafeMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  status: MessageStatus;
  errorMessage?: string;
  attachment?: MessageAttachment;
  createdAt: Date;
  updatedAt?: Date;
}

export interface SendMessageResponse {
  userMessage: SafeMessage;
  assistantMessage: SafeMessage;
}
