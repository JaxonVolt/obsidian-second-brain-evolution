import { createCipheriv, randomBytes } from 'crypto';

import { decryptIlinkMedia, sanitizeWechatFileName } from '../../../../src/core/wechat/WeChatMediaService';

describe('WeChatMediaService', () => {
  it('decrypts AES-128-ECB media payloads', () => {
    const key = randomBytes(16);
    const cipher = createCipheriv('aes-128-ecb', key, null);
    const encrypted = Buffer.concat([cipher.update(Buffer.from('second brain')), cipher.final()]);

    expect(decryptIlinkMedia(encrypted, key.toString('base64')).toString()).toBe('second brain');
  });

  it('removes traversal and invalid Windows filename characters', () => {
    expect(sanitizeWechatFileName('../a:b?.pdf')).toBe('a_b_.pdf');
  });
});
