import { get, post } from '../request'

export interface ReviewItem {
  id: string
  channelId: string
  channelName: string
  channelIcon: string
  guestName: string
  rating: number
  content: string
  roomType: string
  stayDate: string
  replyStatus: string
  replyContent: string
  reviewTime: string
}

export function getReviews(): Promise<ReviewItem[]> {
  return get('/api/channels', { type: 'reviews' })
}

export function replyReview(reviewId: string, content: string): Promise<void> {
  return post('/api/channels', { action: 'reply', reviewId, content })
}
