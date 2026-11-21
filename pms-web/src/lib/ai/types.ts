/** AI 对话相关类型定义 */

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export interface ChatHistoryItem {
  role: 'user' | 'assistant';
  content: string;
}

export interface StreamChatOptions {
  message: string;
  history: ChatHistoryItem[];
  onUpdate: (fullText: string) => void;
  onError?: (error: unknown) => void;
}

export interface StreamChatResult {
  fullText: string;
  success: boolean;
}
