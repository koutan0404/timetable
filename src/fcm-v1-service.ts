// src/fcm-v1-service.ts
// Firebase Cloud Messaging HTTP v1 API 実装（Cloudflare Workers用）

import { SignJWT, importPKCS8 } from 'jose';

// Cloudflare Workersの型を使用（@cloudflare/workers-typesから）
// 型定義は外部から提供されるため、ここでは定義しない




/**
 * サービスアカウント認証情報
 */
interface ServiceAccount {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  auth_uri: string;
  token_uri: string;
  auth_provider_x509_cert_url: string;
  client_x509_cert_url: string;
}

/**
 * FCM v1 APIメッセージ構造
 */
interface FCMMessage {
  message: {
    token?: string;
    topic?: string;
    condition?: string;
    notification?: {
      title: string;
      body: string;
      image?: string;
    };
    data?: Record<string, string>;
    android?: {
      priority?: 'normal' | 'high';
      ttl?: string;
      notification?: {
        icon?: string;
        color?: string;
        sound?: string;
        tag?: string;
        click_action?: string;
        channel_id?: string;
        image?: string;
      };
    };
    apns?: {
      headers?: Record<string, string>;
      payload?: {
        aps: {
          alert?: {
            title?: string;
            subtitle?: string;
            body?: string;
          };
          badge?: number;
          sound?: string | { critical?: number; name?: string; volume?: number };
          thread_id?: string;
          category?: string;
          content_available?: boolean;
          mutable_content?: boolean;
        };
      };
    };
    webpush?: {
      headers?: Record<string, string>;
      data?: Record<string, string>;
      notification?: {
        title?: string;
        body?: string;
        icon?: string;
        badge?: string;
        image?: string;
        data?: Record<string, any>;
        actions?: Array<{
          action: string;
          title: string;
          icon?: string;
        }>;
      };
    };
  };
}

/**
 * FCM HTTP v1 APIサービス
 */
export class FCMv1Service {
  private serviceAccount: ServiceAccount;
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;

  constructor(serviceAccountJson: string) {
    this.serviceAccount = JSON.parse(serviceAccountJson);
  }

  /**
   * アクセストークンの取得（JWT署名とOAuth2認証）
   */
  private async getAccessToken(): Promise<string> {
    // キャッシュされたトークンが有効な場合は再利用
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    try {
      // JWTの作成
      const jwt = await this.createJWT();
      
      // OAuth2トークンエンドポイントにリクエスト
      const response = await fetch(this.serviceAccount.token_uri, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: jwt,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Token exchange failed: ${error}`);
      }

      interface TokenResponse {
        access_token: string;
        expires_in: number;
        token_type: string;
      }

      const data = await response.json() as TokenResponse;

      // トークンとその有効期限をキャッシュ
      this.accessToken = data.access_token;
      this.tokenExpiry = Date.now() + (data.expires_in - 60) * 1000; // 60秒の余裕を持たせる

      return data.access_token;
    } catch (error) {
      console.error('Failed to get access token:', error);
      throw error;
    }
  }

  /**
   * JWT作成（サービスアカウント認証用）
   */
  private async createJWT(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    
    // PKCS8形式の秘密鍵をインポート
    const privateKey = await importPKCS8(
      this.serviceAccount.private_key,
      'RS256'
    );

    // JWTクレーム
    const jwt = await new SignJWT({
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
    })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(this.serviceAccount.client_email)
      .setSubject(this.serviceAccount.client_email)
      .setAudience(this.serviceAccount.token_uri)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600) // 1時間有効
      .sign(privateKey);

    return jwt;
  }

  /**
   * 個別デバイスへの通知送信
   */
  async sendToDevice(
    token: string,
    title: string,
    body: string,
    data?: Record<string, string>,
    options?: {
      image?: string;
      badge?: number;
      sound?: string;
      clickAction?: string;
      channelId?: string;
    }
  ): Promise<boolean> {
    const message: FCMMessage = {
      message: {
        token,
        notification: {
          title,
          body,
          image: options?.image,
        },
        data: data || {},
        android: {
          priority: 'high',
          notification: {
            channel_id: options?.channelId || 'default',
            click_action: options?.clickAction,
            icon: 'ic_notification',
            color: '#6750A4',
            sound: options?.sound || 'default',
          },
        },
        apns: {
          payload: {
            aps: {
              alert: {
                title,
                body,
              },
              badge: options?.badge,
              sound: options?.sound || 'default',
              mutable_content: true,
            },
          },
        },
        webpush: {
          notification: {
            title,
            body,
            icon: '/icon-192x192.png',
            badge: '/badge-72x72.png',
            image: options?.image,
          },
        },
      },
    };

    return this.send(message);
  }

  /**
   * トピックへの通知送信
   */
  async sendToTopic(
    topic: string,
    title: string,
    body: string,
    data?: Record<string, string>
  ): Promise<boolean> {
    const message: FCMMessage = {
      message: {
        topic,
        notification: {
          title,
          body,
        },
        data: data || {},
      },
    };

    return this.send(message);
  }

  /**
   * 複数デバイスへの一括送信
   */
  async sendMulticast(
    tokens: string[],
    title: string,
    body: string,
    data?: Record<string, string>
  ): Promise<{ success: number; failure: number; responses: any[] }> {
    const results = await Promise.allSettled(
      tokens.map(token => this.sendToDevice(token, title, body, data))
    );

    const responses = results.map((result, index) => ({
      token: tokens[index],
      success: result.status === 'fulfilled' && result.value,
      error: result.status === 'rejected' ? result.reason : undefined,
    }));

    const success = responses.filter(r => r.success).length;
    const failure = responses.length - success;

    return { success, failure, responses };
  }

  /**
   * 実際の送信処理
   */
  private async send(message: FCMMessage): Promise<boolean> {
    try {
      const accessToken = await this.getAccessToken();
      const url = `https://fcm.googleapis.com/v1/projects/${this.serviceAccount.project_id}/messages:send`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(message),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error('FCM send failed:', error);
        
        // トークンが無効な場合の処理
        if (response.status === 404 || response.status === 400) {
          interface FCMError {
            error?: {
              details?: Array<{
                errorCode?: string;
              }>;
            };
          }
          
          try {
            const errorData: FCMError = JSON.parse(error);
            if (errorData.error?.details?.[0]?.errorCode === 'UNREGISTERED') {
              // トークンが無効 - DBから削除する必要がある
              throw new Error('INVALID_TOKEN');
            }
          } catch (e) {
            // JSONパースエラーの場合は無視
          }
        }
        
        return false;
      }

      interface FCMResponse {
        name: string;
      }

      const result = await response.json() as FCMResponse;
      console.log('FCM send success:', result.name);
      return true;
    } catch (error) {
      console.error('FCM send error:', error);
      throw error;
    }
  }

  /**
   * バッチ送信（最大500メッセージ）
   */
  async sendBatch(messages: FCMMessage[]): Promise<any> {
    // FCM v1 APIではバッチ送信が廃止されたため、並列送信で対応
    const results = await Promise.allSettled(
      messages.map(message => this.send(message))
    );

    return results.map((result, index) => ({
      messageId: index,
      success: result.status === 'fulfilled' && result.value,
      error: result.status === 'rejected' ? result.reason : undefined,
    }));
  }
}

/**
 * Cloudflare Workers用のヘルパークラス
 */
export class FCMNotificationHelper {
  private fcmService: FCMv1Service;

  constructor(
    private db: D1Database,
    serviceAccountJson: string
  ) {
    this.fcmService = new FCMv1Service(serviceAccountJson);
  }

  /**
   * ユーザーのFCMトークンを取得
   */
  private async getUserTokens(userId: string): Promise<Array<{
    fcm_token: string;
    platform: string;
  }>> {
    interface TokenRecord {
      fcm_token: string;
      platform: string;
    }

    const result = await this.db.prepare(
      `SELECT fcm_token, platform FROM user_tokens 
       WHERE user_id = ?1 
       AND updated_at > datetime('now', '-30 days')
       ORDER BY updated_at DESC`
    ).bind(userId).all<TokenRecord>();

    return result.results;
  }

  private async isFollowNotificationEnabled(userId: string): Promise<boolean> {
    try {
      // 設定テーブルが無い環境でも落ちないように try/catch で保護
      const row = await this.db
        .prepare(
          `SELECT allow_follow_notification AS v 
             FROM notification_settings 
            WHERE user_id = ?1`
        )
        .bind(userId)
        .first<{ v: number }>();
      if (row && typeof row.v === 'number') return row.v === 1;
    } catch (_) {
      // notification_settings が無い場合は既定で許可
    }
    return true; // 既定: 許可
  }

  /**
   * フォロー通知
   */
  async sendFollowNotification(
    followeeId: string,
    followerName: string,
    followerId: string
  ): Promise<void> {
    // ユーザーの通知設定を確認（テーブルが無ければ既定で送信）
    const allowed = await this.isFollowNotificationEnabled(followeeId);
    if (!allowed) return;

    const tokens = await this.getUserTokens(followeeId);
    if (tokens.length === 0) return;

    const title = '新しいフォロワー';
    const body = `${followerName}さんがあなたをフォローしました`;
    const data = {
      type: 'follow',
      follower_id: followerId,
      timestamp: new Date().toISOString(),
    };

    const results = await this.fcmService.sendMulticast(
      tokens.map(t => t.fcm_token),
      title,
      body,
      data
    );

    // 無効なトークンを削除（Error オブジェクト or 文字列の両対応）
    for (const r of results.responses) {
      const err = (r as any).error;
      const invalid = err === 'INVALID_TOKEN' || (err && typeof err.message === 'string' && err.message === 'INVALID_TOKEN');
      if (invalid) {
        await this.removeInvalidToken((r as any).token);
      }
    }

    // ログを記録
    await this.logNotification(
      followeeId,
      'follow',
      title,
      body,
      results.success > 0
    );
  }

  /**
   * 無効なトークンの削除
   */
  private async removeInvalidToken(token: string): Promise<void> {
    await this.db.prepare(
      `DELETE FROM user_tokens WHERE fcm_token = ?1`
    ).bind(token).run();
  }

  /**
   * 通知ログの記録
   */
  private async logNotification(
    userId: string,
    type: string,
    title: string,
    body: string,
    success: boolean
  ): Promise<void> {
    await this.db.prepare(
      `INSERT INTO notification_logs 
       (id, user_id, type, title, body, status, sent_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, CURRENT_TIMESTAMP)`
    ).bind(
      crypto.randomUUID(),
      userId,
      type,
      title,
      body,
      success ? 'sent' : 'failed',
      success ? new Date().toISOString() : null
    ).run();
  }
}