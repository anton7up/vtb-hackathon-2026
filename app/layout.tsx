import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "АнтиСкам — защита ваших денег",
  description: "Личный кабинет клиента и рабочее место сотрудника банка",
  icons: {
    icon: "/shield.svg",
    shortcut: "/shield.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
