// 阿里云服务可用性测试 — OSS / SMS / 百炼 / NLS
import { createHmac } from 'crypto';

const AK = process.env.ALIYUN_ACCESS_KEY_ID || '';
const SK = process.env.ALIYUN_ACCESS_KEY_SECRET || '';
const OSS_REGION = process.env.OSS_REGION || 'oss-cn-beijing';
const OSS_BUCKET = process.env.OSS_BUCKET || 'pms-zhisu';
const DASHSCOPE_KEY = (process.env.DASHSCOPE_API_KEY || '').trim();

function hmacSha1(key: string, str: string): string {
  return createHmac('sha1', key).update(str).digest('base64');
}

function hmacSha256(key: string, str: string): string {
  return createHmac('sha256', key).update(str).digest('hex');
}

async function testOSS() {
  console.log('📦 1. OSS 上传测试');
  console.log(`   Region: ${OSS_REGION}  Bucket: ${OSS_BUCKET}`);
  console.log(`   AK: ${AK.substring(0, 8)}***`);

  if (!AK || !SK) {
    console.log('   ❌ 未配置 AK/SK\n');
    return false;
  }

  try {
    // OSS PutObject 签名
    const date = new Date().toUTCString();
    const objectKey = `test/health-check-${Date.now()}.txt`;
    const host = `${OSS_BUCKET}.${OSS_REGION}.aliyuncs.com`;
    const body = 'pms-health-check';

    const method = 'PUT';
    const contentType = 'text/plain';
    const stringToSign = `${method}\n\n${contentType}\n${date}\n/${OSS_BUCKET}/${objectKey}`;
    const signature = hmacSha1(SK, stringToSign);

    const url = `https://${host}/${objectKey}`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        'Date': date,
        'Authorization': `OSS ${AK}:${signature}`,
      },
      body,
    });

    if (res.ok) {
      console.log(`   ✅ OSS 上传成功 → ${url}`);
      // 清理测试文件
      const delSig = hmacSha1(SK, `DELETE\n\n\n${date}\n/${OSS_BUCKET}/${objectKey}`);
      await fetch(url, {
        method: 'DELETE',
        headers: { 'Date': date, 'Authorization': `OSS ${AK}:${delSig}` },
      });
      return true;
    } else {
      const errText = await res.text();
      console.log(`   ❌ OSS 失败 HTTP ${res.status}: ${errText.substring(0, 200)}`);
      return false;
    }
  } catch (err: any) {
    console.log(`   ❌ OSS 异常: ${err.message}`);
    return false;
  } finally {
    console.log('');
  }
}

async function testSMS() {
  console.log('📱 2. SMS 短信服务测试 (验证凭证可用性)');

  if (!AK || !SK) {
    console.log('   ❌ 未配置 AK/SK\n');
    return false;
  }

  try {
    // SMS SendSms 使用 POP 签名 (HMAC-SHA1)
    const params: Record<string, string> = {
      AccessKeyId: AK,
      Action: 'QuerySendDetails',
      Format: 'JSON',
      PhoneNumber: '13800138000',
      SendDate: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
      PageSize: '1',
      CurrentPage: '1',
      SignatureMethod: 'HMAC-SHA1',
      SignatureNonce: Date.now().toString(),
      SignatureVersion: '1.0',
      Timestamp: new Date().toISOString().replace(/\.\d{3}/, ''),
      Version: '2017-05-25',
    };

    // 排序并构造签名
    const sortedKeys = Object.keys(params).sort();
    const canonicalizedQueryString = sortedKeys
      .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
      .join('&');

    const stringToSign = `GET&${encodeURIComponent('/')}&${encodeURIComponent(canonicalizedQueryString)}`;
    const signature = hmacSha1(`${SK}&`, stringToSign);

    const queryString = `${canonicalizedQueryString}&Signature=${encodeURIComponent(signature)}`;
    const url = `https://dysmsapi.aliyuncs.com/?${queryString}`;

    const res = await fetch(url);
    const data = await res.json();

    if (data.Code === 'OK' || data.Code === 'isv.INVALID_PARAMETERS' || data.Code?.includes('MOBILE')) {
      // isv.INVALID_PARAMETERS 说明凭证有效，只是手机号不合法
      console.log(`   ✅ SMS 凭证有效 (API 响应: ${data.Code})`);
      return true;
    } else if (data.Code?.includes('InvalidAccessKeyId') || data.Code?.includes('Forbidden')) {
      console.log(`   ❌ SMS 凭证无效: ${data.Code} - ${data.Message}`);
      return false;
    } else if (data.Code?.includes('Signature')) {
      console.log(`   ❌ SMS 签名错误: ${data.Code} - ${data.Message}`);
      return false;
    } else {
      console.log(`   ⚠️  SMS 响应: ${data.Code} - ${data.Message}`);
      return false;
    }
  } catch (err: any) {
    console.log(`   ❌ SMS 异常: ${err.message}`);
    return false;
  } finally {
    console.log('');
  }
}

async function testDashScope() {
  console.log('🤖 3. 百炼 DashScope API 测试');

  if (!DASHSCOPE_KEY) {
    console.log('   ❌ 未配置 DASHSCOPE_API_KEY\n');
    return false;
  }

  console.log(`   Key: ${DASHSCOPE_KEY.substring(0, 12)}***`);

  try {
    // 轻量文本生成测试
    const res = await fetch('https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DASHSCOPE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'qwen-turbo',
        input: { messages: [{ role: 'user', content: 'hi' }] },
        parameters: { max_tokens: 10, result_format: 'message' },
      }),
    });

    const data = await res.json();
    if (data.output) {
      console.log(`   ✅ 百炼 API 正常 → ${data.output.choices?.[0]?.message?.content?.substring(0, 30) || 'OK'}`);
      return true;
    } else if (data.code === 'InvalidApiKey') {
      console.log(`   ❌ 百炼 Key 无效: ${data.message}`);
      return false;
    } else if (data.code === 'AccessDenied') {
      console.log(`   ❌ 百炼 无权限: ${data.message}`);
      return false;
    } else {
      console.log(`   ⚠️  百炼 响应: ${JSON.stringify(data).substring(0, 200)}`);
      return false;
    }
  } catch (err: any) {
    console.log(`   ❌ 百炼 异常: ${err.message}`);
    return false;
  } finally {
    console.log('');
  }
}

async function testNLS() {
  console.log('🎤 4. NLS 语音识别测试');

  if (!AK || !SK) {
    console.log('   ❌ 未配置 AK/SK\n');
    return false;
  }

  try {
    // NLS CreateToken 接口
    const params: Record<string, string> = {
      AccessKeyId: AK,
      Action: 'CreateToken',
      Format: 'JSON',
      SignatureMethod: 'HMAC-SHA1',
      SignatureNonce: Date.now().toString(),
      SignatureVersion: '1.0',
      Timestamp: new Date().toISOString().replace(/\.\d{3}/, ''),
      Version: '2019-02-28',
    };

    const sortedKeys = Object.keys(params).sort();
    const canonicalizedQueryString = sortedKeys
      .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
      .join('&');

    const stringToSign = `GET&${encodeURIComponent('/')}&${encodeURIComponent(canonicalizedQueryString)}`;
    const signature = hmacSha1(`${SK}&`, stringToSign);

    const queryString = `${canonicalizedQueryString}&Signature=${encodeURIComponent(signature)}`;
    const url = `https://nls-meta.cn-shanghai.aliyuncs.com/?${queryString}`;

    const res = await fetch(url);
    const data = await res.json();

    if (data.Token) {
      console.log(`   ✅ NLS 凭证有效 → Token: ${(data.Token as string).substring(0, 20)}...`);
      return true;
    } else if (data.Code?.includes('InvalidAccessKeyId') || data.Code?.includes('Forbidden')) {
      console.log(`   ❌ NLS 凭证无效: ${data.Code}`);
      return false;
    } else {
      console.log(`   ⚠️  NLS 响应: ${JSON.stringify(data).substring(0, 200)}`);
      return false;
    }
  } catch (err: any) {
    console.log(`   ❌ NLS 异常: ${err.message}`);
    return false;
  } finally {
    console.log('');
  }
}

// ========== 主流程 ==========
async function main() {
  console.log('═══════════════════════════════════');
  console.log('  阿里云服务可用性诊断');
  console.log('═══════════════════════════════════');
  console.log('');

  const results: Record<string, boolean> = {};

  results.oss = await testOSS();
  results.sms = await testSMS();
  results.dashscope = await testDashScope();
  results.nls = await testNLS();

  console.log('═══════════════════════════════════');
  console.log('  诊断汇总');
  console.log('═══════════════════════════════════');
  console.log(`  OSS:      ${results.oss ? '✅' : '❌'}`);
  console.log(`  SMS:      ${results.sms ? '✅' : '❌'}`);
  console.log(`  百炼:     ${results.dashscope ? '✅' : '❌'}`);
  console.log(`  NLS:      ${results.nls ? '✅' : '❌'}`);

  const allFail = !results.oss && !results.sms && !results.nls;
  if (allFail) {
    console.log('');
    console.log('💡 分析：OSS/SMS/NLS 共用同一对 AK/SK 且全部失败');
    console.log('   可能原因:');
    console.log('   1. AK/SK 已被删除或禁用');
    console.log('   2. RAM 用户被删除');
    console.log('   3. 系统时间偏差 >15分钟（但已在请求中设置 Date header）');
    console.log('   建议: 登录阿里云 RAM 控制台检查 AccessKey 状态');
  }
}

main();
