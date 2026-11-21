import { get, post } from '@/api/request'
import type { LoginParams, LoginResult, EmployeeInfo } from '@/types'

export function sendSmsCode(phone: string): Promise<any> {
	return post('/api/auth/send-sms', { phone })
}

export function smsLogin(params: LoginParams): Promise<LoginResult> {
	return post('/api/auth/login', params)
}

export function passwordLogin(params: LoginParams): Promise<LoginResult> {
	return post('/api/auth/login', params)
}

export function logout(): Promise<any> {
	return post('/api/auth/logout')
}

export function getUserInfo(): Promise<EmployeeInfo> {
	return get('/api/auth/me')
}

export function changePassword(oldPassword: string, newPassword: string): Promise<any> {
	return post('/api/auth/change-password', {
		oldPassword,
		newPassword
	})
}

export function getRoles(): Promise<any> {
	return get('/api/staff?type=roles')
}

export function switchRole(roleType: string): Promise<LoginResult> {
	return post('/api/auth/switch-role', { roleType })
}
