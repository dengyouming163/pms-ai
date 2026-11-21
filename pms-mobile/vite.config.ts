import { defineConfig, type Plugin } from 'vite'
import uni from '@dcloudio/vite-plugin-uni'
import path from 'path'

const dcloudVueRuntime = process.env.UNI_APP_X === 'true'
	? './node_modules/@dcloudio/uni-mp-vue/dist-x/vue.runtime.esm.js'
	: process.env.UNI_PLATFORM === 'h5' || process.env.UNI_PLATFORM === 'web'
		? './node_modules/@dcloudio/uni-h5-vue/dist/vue.runtime.esm.js'
		: './node_modules/@dcloudio/uni-mp-vue/dist/vue.runtime.esm.js'

function uniVueRuntimeAlias(): Plugin {
	return {
		name: 'uni-vue-runtime-alias',
		enforce: 'pre',
		resolveId(source) {
			if (source === 'vue') {
				return path.resolve(__dirname, dcloudVueRuntime)
			}
		}
	}
}

export default defineConfig({
	plugins: [uniVueRuntimeAlias(), uni()],
	resolve: {
		alias: [
			{
				find: 'vue',
				replacement: path.resolve(__dirname, dcloudVueRuntime)
			},
			{
				find: '@',
				replacement: path.resolve(__dirname, './src')
			}
		]
	},
	css: {
		preprocessorOptions: {
			scss: {
				api: 'modern-compiler',
				silenceDeprecations: ['legacy-js-api', 'import']
			}
		}
	},
	server: {
		port: 8081,
		proxy: {
			'/api': {
				target: 'http://132.232.166.40:20002',
				changeOrigin: true,
				secure: false
			},
			'/aiapi': {
				target: 'http://132.232.166.40:20002',
				changeOrigin: true,
				secure: false
			},
			'/storeapi': {
				target: 'http://132.232.166.40:20002',
				changeOrigin: true,
				secure: false
			}
		}
	}
})
