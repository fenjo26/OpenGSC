"use client";

import { useSession, signIn, signOut } from "next-auth/react";
import { LogOut, LogIn } from "lucide-react";

export default function AuthButton() {
  const { data: session, status } = useSession();

  if (status === "loading") {
    return (
      <button disabled style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 12px', borderRadius: '8px', color: 'var(--color-text-secondary)', width: '100%' }}>
        <div style={{ width: '18px', height: '18px', animation: 'spin 1s linear infinite', border: '2px solid rgba(255,255,255,0.1)', borderTopColor: '#fff', borderRadius: '50%' }}></div>
        <span style={{ fontSize: '14px', fontWeight: 500 }}>Loading...</span>
      </button>
    );
  }

  if (session) {
    return (
      <button 
        onClick={() => signOut()}
        style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 12px', borderRadius: '8px', color: 'var(--color-text-secondary)', width: '100%', transition: 'background-color 0.2s' }}
        onMouseOver={e => e.currentTarget.style.backgroundColor = 'rgba(239, 68, 68, 0.1)'}
        onMouseOut={e => e.currentTarget.style.backgroundColor = 'transparent'}
      >
        {session.user?.image ? (
          <img src={session.user.image} alt="User avatar" style={{ width: '18px', height: '18px', borderRadius: '50%' }} />
        ) : (
          <LogOut size={18} />
        )}
        <span style={{ fontSize: '14px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {session.user?.name || 'Sign Out'}
        </span>
      </button>
    );
  }

  return (
    <button 
      // To the login page, not straight to Google: once the owner has a password, Google is no
      // longer a way in, and the page knows which doors are open.
      onClick={() => signIn()}
      style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 12px', borderRadius: '8px', background: 'var(--color-accent-purple)', color: '#fff', width: '100%' }}
    >
      <LogIn size={18} />
      <span style={{ fontSize: '14px', fontWeight: 500 }}>Sign In</span>
    </button>
  );
}
