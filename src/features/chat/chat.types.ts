export interface SafeConversation {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SafeMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: Date;
  updatedAt?: Date;
}

export interface SendMessageResponse {
  userMessage: SafeMessage;
  assistantMessage: SafeMessage;
}
