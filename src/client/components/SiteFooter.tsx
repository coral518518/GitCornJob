/** 全站页脚：版权年份与仓库链接（公开状态页 / 登录页 / 管理后台共用） */
export default function SiteFooter() {
  return (
    <footer className="py-6 text-center text-xs text-fg-subtle">
      Copyright © {new Date().getFullYear()}{" "}
    </footer>
  );
}
