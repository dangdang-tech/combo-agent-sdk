export default function Home() {
  return (
    <main style={{ fontFamily: 'system-ui', margin: '48px auto', maxWidth: 720, padding: 24 }}>
      <h1>Combo Reference Agent</h1>
      <p>服务已启动。健康检查位于 /api/healthz，业务接口位于 /api/chat。</p>
      <p>余额不足时，业务接口只会把 Combo 的短期支付凭证交给 Host。</p>
    </main>
  );
}
