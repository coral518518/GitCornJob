const REPO_URL = "https://github.com/lyan0220/Cronhub";

/** 全站页脚：版权年份与仓库链接（公开状态页 / 登录页 / 管理后台共用） */
export default function SiteFooter() {
  return (
    <footer className="py-6 text-center text-xs text-fg-subtle">
      Copyright © {new Date().getFullYear()}{" "}
      <a href={REPO_URL} target="_blank" rel="noreferrer"
        className="transition-colors hover:text-fg hover:underline">
        Cronhub
      </a>
    </footer>
  );
}
