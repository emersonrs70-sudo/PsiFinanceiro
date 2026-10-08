import React, { useState, useEffect, useRef, useMemo } from 'react';
import Chart from 'chart.js/auto';
import {
  auth,
  db,
  loginWithGoogle,
  logoutUser,
  handleFirestoreError,
  OperationType,
} from './firebase';
import { onAuthStateChanged, User } from 'firebase/auth';
import {
  collection,
  doc,
  setDoc,
  deleteDoc,
  writeBatch,
  onSnapshot,
  query,
  orderBy,
} from 'firebase/firestore';

export interface Sessao {
  id: string;
  nomePaciente: string;
  dataStr: string; // YYYY-MM-DD
  valor: number;
  observacoes?: string;
  timestamp?: string;
  userId?: string;
}

const mesesNomes = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
const mesesCompletos = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
];

export default function App() {
  // Navigation
  const [activeTab, setActiveTab] = useState<'dashboard' | 'registros' | 'historico'>('dashboard');
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Data & Cloud Auth
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [syncStatus, setSyncStatus] = useState<'synced' | 'syncing' | 'offline'>('synced');
  const [sessoes, setSessoes] = useState<Sessao[]>(() => {
    try {
      const saved = localStorage.getItem('psicoControl_sessoes');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  // Form
  const [formNome, setFormNome] = useState('');
  const [formDataSessao, setFormDataSessao] = useState(() => new Date().toISOString().split('T')[0]);
  const [formValor, setFormValor] = useState('');
  const [formObservacoes, setFormObservacoes] = useState('');

  // Filters
  const [filtroNome, setFiltroNome] = useState('');
  const [filtroMes, setFiltroMes] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
  const [anoGrafico, setAnoGrafico] = useState<string>(() => new Date().getFullYear().toString());

  // Chart ref
  const chartCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartInstanceRef = useRef<Chart | null>(null);

  // Toast
  const [toast, setToast] = useState<{
    visible: boolean;
    title: string;
    message: string;
    type: 'success' | 'error';
  }>({
    visible: false,
    title: '',
    message: '',
    type: 'success',
  });

  // Modals
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [confirmModal, setConfirmModal] = useState<{
    open: boolean;
    title: string;
    message: string;
    action?: () => void;
  }>({
    open: false,
    title: '',
    message: '',
  });

  // Toast helper
  const mostrarNotificacao = (title: string, message: string, type: 'success' | 'error' = 'success') => {
    setToast({ visible: true, title, message, type });
    setTimeout(() => {
      setToast((prev) => ({ ...prev, visible: false }));
    }, 3200);
  };

  // Auth Observer
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setAuthLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // Save to LocalStorage whenever sessoes changes
  useEffect(() => {
    try {
      localStorage.setItem('psicoControl_sessoes', JSON.stringify(sessoes));
    } catch (e) {
      console.error('Erro ao salvar localmente:', e);
    }
  }, [sessoes]);

  // Firestore Cloud Sync
  useEffect(() => {
    if (!user) return;

    setSyncStatus('syncing');
    const path = `users/${user.uid}/sessoes`;
    const colRef = collection(db, 'users', user.uid, 'sessoes');
    const q = query(colRef, orderBy('dataStr', 'desc'));

    const unsubscribe = onSnapshot(
      q,
      async (snapshot) => {
        // If firestore has items, update state
        if (!snapshot.empty) {
          const items: Sessao[] = [];
          snapshot.forEach((docSnap) => {
            items.push({ id: docSnap.id, ...docSnap.data() } as Sessao);
          });
          setSessoes(items);
          setSyncStatus('synced');
        } else {
          // If firestore is empty but we have local sessions, migrate them to cloud!
          const localSaved = localStorage.getItem('psicoControl_sessoes');
          const localList: Sessao[] = localSaved ? JSON.parse(localSaved) : [];
          if (localList.length > 0) {
            try {
              const batch = writeBatch(db);
              localList.forEach((sessao) => {
                const sId = sessao.id || `sess_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
                const docRef = doc(db, 'users', user.uid, 'sessoes', sId);
                batch.set(docRef, {
                  id: sId,
                  nomePaciente: sessao.nomePaciente,
                  dataStr: sessao.dataStr,
                  valor: sessao.valor,
                  observacoes: sessao.observacoes || '',
                  timestamp: sessao.timestamp || new Date().toISOString(),
                  userId: user.uid,
                });
              });
              await batch.commit();
              mostrarNotificacao('Nuvem Sincronizada', 'Seus registros locais foram salvos na nuvem!');
            } catch (err) {
              console.error('Erro ao migrar dados locais para a nuvem:', err);
            }
          }
          setSyncStatus('synced');
        }
      },
      (error) => {
        setSyncStatus('offline');
        console.error('Erro Firestore onSnapshot:', error);
      }
    );

    return () => unsubscribe();
  }, [user]);

  // Patients autocomplete suggestions
  const pacientesSugestoes = useMemo(() => {
    const nomes = Array.from(new Set(sessoes.map((s) => s.nomePaciente.trim()))).filter(Boolean).sort();
    return nomes;
  }, [sessoes]);

  // Filtered History
  const sessoesFiltradas = useMemo(() => {
    let result = sessoes;
    if (filtroNome.trim()) {
      const termo = filtroNome.toLowerCase().trim();
      result = result.filter((s) => s.nomePaciente.toLowerCase().includes(termo));
    }
    if (filtroMes) {
      result = result.filter((s) => s.dataStr.startsWith(filtroMes));
    }
    return result;
  }, [sessoes, filtroNome, filtroMes]);

  const somaFiltro = useMemo(() => {
    return sessoesFiltradas.reduce((acc, s) => acc + s.valor, 0);
  }, [sessoesFiltradas]);

  // Form Submit
  const salvarSessao = async (e: React.FormEvent) => {
    e.preventDefault();

    const nome = formNome.trim();
    const data = formDataSessao;
    const valor = parseFloat(formValor);
    const obs = formObservacoes.trim();

    if (!nome || !data || isNaN(valor)) {
      mostrarNotificacao('Erro', 'Preencha todos os campos obrigatórios corretamente.', 'error');
      return;
    }

    const novaSessaoId = Date.now().toString();
    const novaSessao: Sessao = {
      id: novaSessaoId,
      nomePaciente: nome,
      dataStr: data,
      valor: valor,
      observacoes: obs,
      timestamp: new Date().toISOString(),
      userId: user ? user.uid : undefined,
    };

    // Update local immediately
    const updated = [novaSessao, ...sessoes].sort(
      (a, b) => new Date(b.dataStr).getTime() - new Date(a.dataStr).getTime()
    );
    setSessoes(updated);

    // Save to Cloud if authenticated
    if (user) {
      setSyncStatus('syncing');
      try {
        await setDoc(doc(db, 'users', user.uid, 'sessoes', novaSessaoId), {
          id: novaSessaoId,
          nomePaciente: nome,
          dataStr: data,
          valor: valor,
          observacoes: obs,
          timestamp: novaSessao.timestamp,
          userId: user.uid,
        });
        setSyncStatus('synced');
      } catch (err) {
        setSyncStatus('offline');
        handleFirestoreError(err, OperationType.CREATE, `users/${user.uid}/sessoes/${novaSessaoId}`);
      }
    }

    // Reset Form
    setFormNome('');
    setFormDataSessao(new Date().toISOString().split('T')[0]);
    setFormValor('');
    setFormObservacoes('');

    mostrarNotificacao('Sucesso', 'Sessão registrada com sucesso!');
    setTimeout(() => setActiveTab('dashboard'), 800);
  };

  // Delete
  const confirmarExcluirSessao = (id: string) => {
    setConfirmModal({
      open: true,
      title: 'Excluir Registro',
      message: 'Esta ação apagará permanentemente este registro. Deseja continuar?',
      action: async () => {
        // Remove locally
        setSessoes((prev) => prev.filter((s) => s.id !== id));

        // Remove from cloud if user is logged in
        if (user) {
          setSyncStatus('syncing');
          try {
            await deleteDoc(doc(db, 'users', user.uid, 'sessoes', id));
            setSyncStatus('synced');
          } catch (err) {
            setSyncStatus('offline');
            handleFirestoreError(err, OperationType.DELETE, `users/${user.uid}/sessoes/${id}`);
          }
        }
        mostrarNotificacao('Sucesso', 'Registro excluído.');
      },
    });
  };

  // Format Currency
  const formatarMoeda = (valor: number) => {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(valor);
  };

  // Years for Chart selector
  const anosDisponiveis = useMemo(() => {
    const anos = Array.from(new Set(sessoes.map((s) => s.dataStr.substring(0, 4)))).sort().reverse();
    const anoAtualStr = new Date().getFullYear().toString();
    if (!anos.includes(anoAtualStr)) {
      anos.unshift(anoAtualStr);
    }
    return anos;
  }, [sessoes]);

  // Dashboard calculations
  const dashboardData = useMemo(() => {
    const dataAtual = new Date();
    const anoAtual = dataAtual.getFullYear();
    const mesAtual = dataAtual.getMonth() + 1;
    const mesAtualStr = String(mesAtual).padStart(2, '0');
    const mesPassado = mesAtual === 1 ? 12 : mesAtual - 1;
    const anoMesPassado = mesAtual === 1 ? anoAtual - 1 : anoAtual;
    const mesPassadoStr = String(mesPassado).padStart(2, '0');

    let faturamentoMes = 0;
    let faturamentoMesPassado = 0;
    let qtdSessoesMes = 0;
    let faturamentoAno = 0;

    const faturamentoPorMes = new Array(12).fill(0);
    const pacientesMesAtual: Record<string, number> = {};

    sessoes.forEach((s) => {
      const sAno = s.dataStr.substring(0, 4);
      const sMes = parseInt(s.dataStr.substring(5, 7), 10);
      const sMesStr = s.dataStr.substring(5, 7);

      if (sAno === anoGrafico) {
        faturamentoAno += s.valor;
        if (sMes >= 1 && sMes <= 12) {
          faturamentoPorMes[sMes - 1] += s.valor;
        }
      }

      if (sAno === anoAtual.toString() && sMesStr === mesAtualStr) {
        faturamentoMes += s.valor;
        qtdSessoesMes++;
        pacientesMesAtual[s.nomePaciente] = (pacientesMesAtual[s.nomePaciente] || 0) + s.valor;
      }

      if (sAno === anoMesPassado.toString() && sMesStr === mesPassadoStr) {
        faturamentoMesPassado += s.valor;
      }
    });

    // Top Patients
    const topPacientes = Object.keys(pacientesMesAtual)
      .map((nome) => ({ nome, total: pacientesMesAtual[nome] }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 5);

    const maiorValorTop = topPacientes.length > 0 ? topPacientes[0].total : 1;

    return {
      mesAtualNome: mesesCompletos[mesAtual - 1],
      faturamentoMes,
      qtdSessoesMes,
      faturamentoAno,
      faturamentoMesPassado,
      faturamentoPorMes,
      topPacientes,
      maiorValorTop,
    };
  }, [sessoes, anoGrafico]);

  // Chart Rendering
  useEffect(() => {
    if (activeTab !== 'dashboard') return;
    if (!chartCanvasRef.current) return;

    const ctx = chartCanvasRef.current.getContext('2d');
    if (!ctx) return;

    if (chartInstanceRef.current) {
      chartInstanceRef.current.destroy();
    }

    const gradient = ctx.createLinearGradient(0, 0, 0, 320);
    gradient.addColorStop(0, 'rgba(79, 70, 229, 0.45)');
    gradient.addColorStop(1, 'rgba(79, 70, 229, 0.0)');

    chartInstanceRef.current = new Chart(ctx, {
      type: 'line',
      data: {
        labels: mesesNomes,
        datasets: [
          {
            label: `Faturamento ${anoGrafico}`,
            data: dashboardData.faturamentoPorMes,
            borderColor: '#4f46e5',
            backgroundColor: gradient,
            borderWidth: 2,
            pointBackgroundColor: '#ffffff',
            pointBorderColor: '#4f46e5',
            pointBorderWidth: 2,
            pointRadius: 4,
            pointHoverRadius: 6,
            fill: true,
            tension: 0.3,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (context) => {
                let label = context.dataset.label || '';
                if (label) label += ': ';
                if (context.parsed.y !== null) {
                  label += formatarMoeda(context.parsed.y);
                }
                return label;
              },
            },
          },
        },
        scales: {
          y: {
            beginAtZero: true,
            grid: {
              color: '#f3f4f6',
            },
            ticks: {
              callback: (value) => 'R$ ' + Number(value).toLocaleString('pt-BR'),
            },
          },
          x: {
            grid: {
              display: false,
            },
          },
        },
        interaction: {
          intersect: false,
          mode: 'index',
        },
      },
    });

    return () => {
      if (chartInstanceRef.current) {
        chartInstanceRef.current.destroy();
        chartInstanceRef.current = null;
      }
    };
  }, [activeTab, anoGrafico, dashboardData.faturamentoPorMes]);

  // Export JSON
  const exportarDados = () => {
    if (sessoes.length === 0) {
      mostrarNotificacao('Aviso', 'Não há dados para exportar.', 'error');
      return;
    }
    const dataStr = JSON.stringify(sessoes, null, 2);
    const dataUri = 'data:application/json;charset=utf-8,' + encodeURIComponent(dataStr);
    const exportFileName = `psicocontrol_backup_${new Date().toISOString().slice(0, 10)}.json`;

    const link = document.createElement('a');
    link.href = dataUri;
    link.download = exportFileName;
    link.click();

    setIsExportModalOpen(false);
    mostrarNotificacao('Sucesso', 'Arquivo de backup baixado.');
  };

  // Import JSON
  const importarDados = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const dadosImportados = JSON.parse(e.target?.result as string);
        if (Array.isArray(dadosImportados)) {
          setConfirmModal({
            open: true,
            title: 'Importar Backup',
            message:
              'Isso irá mesclar os dados importados com os atuais. Registros com o mesmo ID não serão duplicados. Deseja continuar?',
            action: async () => {
              const idsExistentes = new Set(sessoes.map((s) => s.id));
              const novos: Sessao[] = [];

              dadosImportados.forEach((item) => {
                if (item.id && !idsExistentes.has(item.id)) {
                  novos.push(item);
                }
              });

              const atualizados = [...sessoes, ...novos].sort(
                (a, b) => new Date(b.dataStr).getTime() - new Date(a.dataStr).getTime()
              );
              setSessoes(atualizados);

              // Upload to firestore if user is logged in
              if (user && novos.length > 0) {
                const batch = writeBatch(db);
                novos.forEach((item) => {
                  const docRef = doc(db, 'users', user.uid, 'sessoes', item.id);
                  batch.set(docRef, { ...item, userId: user.uid }, { merge: true });
                });
                await batch.commit();
              }

              setIsExportModalOpen(false);
              mostrarNotificacao('Sucesso', `${novos.length} novos registros importados.`);
            },
          });
        } else {
          throw new Error('Formato inválido');
        }
      } catch {
        setIsExportModalOpen(false);
        mostrarNotificacao('Erro', 'Arquivo de backup inválido.', 'error');
      }
    };
    reader.readAsText(file);
    event.target.value = '';
  };

  // Clear all data
  const confirmarLimpezaDados = () => {
    setConfirmModal({
      open: true,
      title: 'ATENÇÃO: Apagar Tudo',
      message: 'Esta ação apagará TODOS os registros de sessões salvos. É irreversível. Deseja continuar?',
      action: async () => {
        if (user) {
          const batch = writeBatch(db);
          sessoes.forEach((s) => {
            batch.delete(doc(db, 'users', user.uid, 'sessoes', s.id));
          });
          await batch.commit();
        }
        setSessoes([]);
        localStorage.removeItem('psicoControl_sessoes');
        setIsExportModalOpen(false);
        mostrarNotificacao('Sucesso', 'Todos os dados foram apagados.');
      },
    });
  };

  const getPageTitle = () => {
    switch (activeTab) {
      case 'dashboard':
        return 'Visão Geral';
      case 'registros':
        return 'Registrar Atendimento';
      case 'historico':
        return 'Histórico de Atendimentos';
    }
  };

  // Month comparison percentage
  const renderComparacao = () => {
    const { faturamentoMes, faturamentoMesPassado } = dashboardData;
    if (faturamentoMesPassado === 0) {
      if (faturamentoMes > 0) {
        return (
          <>
            <span className="text-green-500 font-medium mr-1">
              <i className="fas fa-arrow-up"></i> 100%
            </span>{' '}
            em relação ao mês passado
          </>
        );
      }
      return <span className="text-gray-400">Sem dados mês passado</span>;
    }
    const variacao = ((faturamentoMes - faturamentoMesPassado) / faturamentoMesPassado) * 100;
    if (variacao > 0) {
      return (
        <>
          <span className="text-green-500 font-medium mr-1">
            <i className="fas fa-arrow-up"></i> {variacao.toFixed(1)}%
          </span>{' '}
          vs mês anterior
        </>
      );
    } else if (variacao < 0) {
      return (
        <>
          <span className="text-red-500 font-medium mr-1">
            <i className="fas fa-arrow-down"></i> {Math.abs(variacao).toFixed(1)}%
          </span>{' '}
          vs mês anterior
        </>
      );
    }
    return (
      <>
        <span className="text-gray-500 font-medium mr-1">
          <i className="fas fa-minus"></i> 0%
        </span>{' '}
        vs mês anterior
      </>
    );
  };

  return (
    <div className="text-gray-800 antialiased h-screen flex overflow-hidden bg-[#f3f4f6]">
      {/* Sidebar Navigation */}
      <aside
        id="sidebar"
        className={`w-64 bg-indigo-900 text-white flex flex-col transition-all duration-300 md:relative fixed z-30 h-full ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
        }`}
      >
        <div className="p-6 flex items-center justify-between border-b border-indigo-800">
          <h1 className="text-2xl font-bold tracking-tight flex items-center">
            <i className="fas fa-brain mr-2"></i>PsicoControl
          </h1>
          <button
            onClick={() => setSidebarOpen(false)}
            className="md:hidden text-indigo-300 hover:text-white"
          >
            <i className="fas fa-times text-xl"></i>
          </button>
        </div>

        <nav className="flex-1 px-4 py-6 space-y-2 overflow-y-auto">
          <button
            onClick={() => {
              setActiveTab('dashboard');
              setSidebarOpen(false);
            }}
            className={`nav-btn w-full flex items-center px-4 py-3 rounded-lg transition-colors ${
              activeTab === 'dashboard'
                ? 'bg-indigo-800 text-white'
                : 'text-indigo-200 hover:bg-indigo-800 hover:text-white'
            }`}
          >
            <i className="fas fa-chart-pie w-6"></i>
            <span className="font-medium">Dashboard</span>
          </button>

          <button
            onClick={() => {
              setActiveTab('registros');
              setSidebarOpen(false);
            }}
            className={`nav-btn w-full flex items-center px-4 py-3 rounded-lg transition-colors ${
              activeTab === 'registros'
                ? 'bg-indigo-800 text-white'
                : 'text-indigo-200 hover:bg-indigo-800 hover:text-white'
            }`}
          >
            <i className="fas fa-list w-6"></i>
            <span className="font-medium">Registrar Sessão</span>
          </button>

          <button
            onClick={() => {
              setActiveTab('historico');
              setSidebarOpen(false);
            }}
            className={`nav-btn w-full flex items-center px-4 py-3 rounded-lg transition-colors ${
              activeTab === 'historico'
                ? 'bg-indigo-800 text-white'
                : 'text-indigo-200 hover:bg-indigo-800 hover:text-white'
            }`}
          >
            <i className="fas fa-history w-6"></i>
            <span className="font-medium">Histórico</span>
          </button>
        </nav>

        {/* Sidebar Footer with Cloud Storage details & Auth */}
        <div className="p-4 border-t border-indigo-800 space-y-3">
          <div className="text-xs text-indigo-200 flex items-center justify-between">
            <span className="flex items-center gap-1.5 font-medium">
              <i className="fas fa-cloud text-indigo-400"></i>
              {user ? 'Nuvem Ativa' : 'Modo Local'}
            </span>
            <span
              className={`w-2 h-2 rounded-full ${
                user
                  ? syncStatus === 'synced'
                    ? 'bg-emerald-400'
                    : syncStatus === 'syncing'
                    ? 'bg-amber-400 animate-pulse'
                    : 'bg-rose-400'
                  : 'bg-indigo-400'
              }`}
            ></span>
          </div>

          {user ? (
            <div className="flex items-center justify-between pt-1">
              <div className="flex items-center gap-2 overflow-hidden">
                {user.photoURL ? (
                  <img
                    src={user.photoURL}
                    alt="Foto do usuário"
                    className="w-7 h-7 rounded-full border border-indigo-700 shrink-0"
                  />
                ) : (
                  <div className="w-7 h-7 rounded-full bg-indigo-700 flex items-center justify-center text-xs font-semibold text-white shrink-0">
                    {user.email ? user.email[0].toUpperCase() : 'U'}
                  </div>
                )}
                <div className="truncate text-xs">
                  <div className="font-medium text-white truncate">{user.displayName || user.email}</div>
                  <div className="text-indigo-300 text-[10px] truncate">{user.email}</div>
                </div>
              </div>
              <button
                onClick={() => logoutUser()}
                title="Sair"
                className="text-indigo-300 hover:text-white p-1 text-xs"
              >
                <i className="fas fa-sign-out-alt"></i>
              </button>
            </div>
          ) : (
            <button
              onClick={() => loginWithGoogle()}
              className="w-full flex items-center justify-center gap-2 px-3 py-1.5 text-xs font-medium bg-indigo-700 hover:bg-indigo-600 text-white rounded-md transition shadow-sm"
            >
              <i className="fab fa-google"></i> Entrar na Nuvem
            </button>
          )}

          <div className="text-[11px] text-indigo-300 text-center leading-tight">
            {user
              ? 'Dados salvos com segurança no Firebase Firestore.'
              : 'Faça login para salvar seus registros na nuvem.'}
          </div>
        </div>
      </aside>

      {/* Overlay for mobile sidebar */}
      {sidebarOpen && (
        <div
          onClick={() => setSidebarOpen(false)}
          className="fixed inset-0 bg-black bg-opacity-50 z-20 md:hidden"
        ></div>
      )}

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col h-full overflow-hidden relative w-full">
        {/* Header */}
        <header className="bg-white shadow-sm z-10 py-4 px-6 flex items-center justify-between">
          <div className="flex items-center">
            <button
              onClick={() => setSidebarOpen(true)}
              className="md:hidden mr-4 text-gray-500 hover:text-indigo-600 focus:outline-none"
            >
              <i className="fas fa-bars text-xl"></i>
            </button>
            <h2 className="text-xl font-semibold text-gray-800">{getPageTitle()}</h2>
          </div>

          <div className="flex items-center space-x-3">
            {/* Cloud badge indicator */}
            {user && (
              <span
                className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200"
                title="Conectado ao Firebase Firestore"
              >
                <i className="fas fa-check-circle text-emerald-500 text-[11px]"></i> Sincronizado
              </span>
            )}

            {!user && (
              <button
                onClick={() => loginWithGoogle()}
                className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-indigo-600 hover:bg-indigo-700 text-white transition shadow-sm"
              >
                <i className="fab fa-google"></i> Conectar Nuvem
              </button>
            )}

            <button
              onClick={() => setIsExportModalOpen(true)}
              className="text-gray-500 hover:text-indigo-600 transition p-2 rounded-md hover:bg-gray-100"
              title="Exportar/Importar Dados"
            >
              <i className="fas fa-cog"></i>
            </button>
          </div>
        </header>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto p-4 md:p-8 bg-gray-50">
          {/* TAB: Dashboard */}
          {activeTab === 'dashboard' && (
            <div className="space-y-6">
              {/* Resumo Cards */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                {/* Faturamento Mês Atual */}
                <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 flex flex-col justify-between hover:shadow-md transition-shadow">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wider">
                      Mês Atual ({dashboardData.mesAtualNome})
                    </h3>
                    <div className="p-2 bg-green-100 rounded-full text-green-600">
                      <i className="fas fa-dollar-sign"></i>
                    </div>
                  </div>
                  <div>
                    <p className="text-3xl font-bold text-gray-800">
                      {formatarMoeda(dashboardData.faturamentoMes)}
                    </p>
                    <p className="text-sm text-gray-500 mt-2 flex items-center">
                      {renderComparacao()}
                    </p>
                  </div>
                </div>

                {/* Sessões Mês Atual */}
                <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 flex flex-col justify-between hover:shadow-md transition-shadow">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wider">
                      Sessões Realizadas
                    </h3>
                    <div className="p-2 bg-blue-100 rounded-full text-blue-600">
                      <i className="fas fa-users"></i>
                    </div>
                  </div>
                  <div>
                    <p className="text-3xl font-bold text-gray-800">{dashboardData.qtdSessoesMes}</p>
                    <p className="text-sm text-gray-500 mt-2">Neste mês</p>
                  </div>
                </div>

                {/* Faturamento Total Ano */}
                <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 flex flex-col justify-between hover:shadow-md transition-shadow">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wider">
                      Faturamento Anual
                    </h3>
                    <div className="p-2 bg-purple-100 rounded-full text-purple-600">
                      <i className="fas fa-wallet"></i>
                    </div>
                  </div>
                  <div>
                    <p className="text-3xl font-bold text-gray-800">
                      {formatarMoeda(dashboardData.faturamentoAno)}
                    </p>
                    <p className="text-sm text-gray-500 mt-2">No ano de {anoGrafico}</p>
                  </div>
                </div>
              </div>

              {/* Gráficos */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Gráfico Principal (Faturamento Anual) */}
                <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 lg:col-span-2">
                  <div className="flex justify-between items-center mb-4">
                    <h3 className="text-lg font-semibold text-gray-800">Evolução do Faturamento</h3>
                    <select
                      value={anoGrafico}
                      onChange={(e) => setAnoGrafico(e.target.value)}
                      className="bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-indigo-500 focus:border-indigo-500 block p-2"
                    >
                      {anosDisponiveis.map((ano) => (
                        <option key={ano} value={ano}>
                          {ano}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="relative h-72 w-full">
                    <canvas ref={chartCanvasRef}></canvas>
                  </div>
                </div>

                {/* Top Pacientes (Mês) */}
                <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
                  <h3 className="text-lg font-semibold text-gray-800 mb-4">Top Pacientes (Mês)</h3>
                  <div className="space-y-4 max-h-72 overflow-y-auto pr-2">
                    {dashboardData.topPacientes.length === 0 ? (
                      <p className="text-gray-500 text-sm italic text-center mt-10">
                        Nenhum dado neste mês ainda.
                      </p>
                    ) : (
                      dashboardData.topPacientes.map((p, index) => {
                        const porcentagem = (p.total / dashboardData.maiorValorTop) * 100;
                        return (
                          <div key={p.nome}>
                            <div className="flex justify-between items-center text-sm mb-1">
                              <span className="font-medium text-gray-700 truncate mr-2">
                                {index + 1}. {p.nome}
                              </span>
                              <span className="text-gray-600 font-semibold">{formatarMoeda(p.total)}</span>
                            </div>
                            <div className="w-full bg-gray-200 rounded-full h-1.5">
                              <div
                                className="bg-indigo-500 h-1.5 rounded-full"
                                style={{
                                  width: `${porcentagem}%`,
                                  opacity: Math.max(0.4, 1 - index * 0.15),
                                }}
                              ></div>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB: Registrar */}
          {activeTab === 'registros' && (
            <div className="max-w-2xl mx-auto mt-4">
              <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
                <div className="bg-indigo-50 px-6 py-4 border-b border-indigo-100">
                  <h3 className="text-lg font-semibold text-indigo-900">Nova Sessão</h3>
                  <p className="text-sm text-indigo-600">Registre os detalhes da sessão finalizada.</p>
                </div>

                <form onSubmit={salvarSessao} className="p-6 space-y-6">
                  <div>
                    <label htmlFor="nomePaciente" className="block text-sm font-medium text-gray-700 mb-1">
                      Nome do Paciente *
                    </label>
                    <input
                      type="text"
                      id="nomePaciente"
                      required
                      value={formNome}
                      onChange={(e) => setFormNome(e.target.value)}
                      className="w-full rounded-md border border-gray-300 px-4 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-shadow"
                      placeholder="Ex: Maria Silva"
                      list="pacientesSugestoesList"
                      autoComplete="off"
                    />
                    <datalist id="pacientesSugestoesList">
                      {pacientesSugestoes.map((nome) => (
                        <option key={nome} value={nome} />
                      ))}
                    </datalist>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div>
                      <label htmlFor="dataSessao" className="block text-sm font-medium text-gray-700 mb-1">
                        Data da Sessão *
                      </label>
                      <input
                        type="date"
                        id="dataSessao"
                        required
                        value={formDataSessao}
                        onChange={(e) => setFormDataSessao(e.target.value)}
                        className="w-full rounded-md border border-gray-300 px-4 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-shadow"
                      />
                    </div>
                    <div>
                      <label htmlFor="valorSessao" className="block text-sm font-medium text-gray-700 mb-1">
                        Valor Recebido (R$) *
                      </label>
                      <div className="relative">
                        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                          <span className="text-gray-500 sm:text-sm">R$</span>
                        </div>
                        <input
                          type="number"
                          id="valorSessao"
                          required
                          min="0"
                          step="0.01"
                          value={formValor}
                          onChange={(e) => setFormValor(e.target.value)}
                          className="w-full rounded-md border border-gray-300 pl-10 pr-4 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-shadow"
                          placeholder="0.00"
                        />
                      </div>
                    </div>
                  </div>

                  <div>
                    <label htmlFor="observacoes" className="block text-sm font-medium text-gray-700 mb-1">
                      Observações (Opcional)
                    </label>
                    <textarea
                      id="observacoes"
                      rows={3}
                      value={formObservacoes}
                      onChange={(e) => setFormObservacoes(e.target.value)}
                      className="w-full rounded-md border border-gray-300 px-4 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-shadow"
                      placeholder="Ex: Pagamento via PIX, Sessão de reposição..."
                    ></textarea>
                  </div>

                  <div className="pt-4 flex items-center justify-end border-t border-gray-100">
                    <button
                      type="button"
                      onClick={() => {
                        setFormNome('');
                        setFormDataSessao(new Date().toISOString().split('T')[0]);
                        setFormValor('');
                        setFormObservacoes('');
                      }}
                      className="mr-4 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                    >
                      Limpar
                    </button>
                    <button
                      type="submit"
                      className="px-6 py-2 text-sm font-medium text-white bg-indigo-600 border border-transparent rounded-md hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 shadow-sm transition-colors flex items-center"
                    >
                      <i className="fas fa-save mr-2"></i> Salvar Registro
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {/* TAB: Histórico */}
          {activeTab === 'historico' && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
              <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 space-y-4 md:space-y-0">
                <h3 className="text-lg font-semibold text-gray-800">Histórico de Sessões</h3>

                {/* Filtros */}
                <div className="flex flex-wrap items-center gap-3 w-full md:w-auto">
                  <div className="relative flex-1 md:w-48">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                      <i className="fas fa-search text-gray-400"></i>
                    </div>
                    <input
                      type="text"
                      placeholder="Buscar paciente..."
                      value={filtroNome}
                      onChange={(e) => setFiltroNome(e.target.value)}
                      className="w-full pl-10 pr-4 py-2 text-sm border border-gray-300 rounded-lg focus:ring-indigo-500 focus:border-indigo-500"
                    />
                  </div>
                  <input
                    type="month"
                    value={filtroMes}
                    onChange={(e) => setFiltroMes(e.target.value)}
                    className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-indigo-500 focus:border-indigo-500"
                  />
                </div>
              </div>

              <div className="overflow-x-auto">
                {sessoesFiltradas.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-gray-500">
                    <i className="fas fa-folder-open text-4xl mb-3 text-gray-300"></i>
                    <p>Nenhum registro encontrado.</p>
                  </div>
                ) : (
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th
                          scope="col"
                          className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                        >
                          Data
                        </th>
                        <th
                          scope="col"
                          className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                        >
                          Paciente
                        </th>
                        <th
                          scope="col"
                          className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                        >
                          Valor
                        </th>
                        <th
                          scope="col"
                          className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider hidden md:table-cell"
                        >
                          Observações
                        </th>
                        <th
                          scope="col"
                          className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider"
                        >
                          Ações
                        </th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {sessoesFiltradas.map((sessao) => {
                        const [ano, mes, dia] = sessao.dataStr.split('-');
                        const dataFormatada = `${dia}/${mes}/${ano}`;

                        return (
                          <tr key={sessao.id} className="hover:bg-gray-50 transition-colors">
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                              {dataFormatada}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                              {sessao.nomePaciente}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-green-600 font-medium">
                              {formatarMoeda(sessao.valor)}
                            </td>
                            <td
                              className="px-6 py-4 text-sm text-gray-500 hidden md:table-cell max-w-xs truncate"
                              title={sessao.observacoes || ''}
                            >
                              {sessao.observacoes || '-'}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                              <button
                                onClick={() => confirmarExcluirSessao(sessao.id)}
                                className="text-red-500 hover:text-red-700 p-2 rounded-full hover:bg-red-50 transition-colors"
                                title="Excluir"
                              >
                                <i className="fas fa-trash"></i>
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>

              {/* Paginação / Totalizador */}
              <div className="mt-4 flex items-center justify-between border-t border-gray-200 pt-4">
                <div className="text-sm text-gray-700">
                  Total: <span className="font-medium">{sessoesFiltradas.length}</span>
                </div>
                <div className="text-sm font-semibold text-indigo-700 bg-indigo-50 px-3 py-1 rounded-full">
                  Soma: {formatarMoeda(somaFiltro)}
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Notificação Toast */}
      <div
        className={`fixed bottom-5 right-5 transform transition-all duration-300 bg-white border-l-4 shadow-lg rounded-md p-4 flex items-center z-50 pointer-events-none ${
          toast.type === 'success' ? 'border-green-500' : 'border-red-500'
        } ${toast.visible ? 'translate-y-0 opacity-100' : 'translate-y-20 opacity-0'}`}
      >
        <i
          className={`text-xl mr-3 ${
            toast.type === 'success'
              ? 'fas fa-check-circle text-green-500'
              : 'fas fa-times-circle text-red-500'
          }`}
        ></i>
        <div className="flex-1">
          <p className="text-sm font-medium text-gray-900">{toast.title}</p>
          <p className="text-xs text-gray-500">{toast.message}</p>
        </div>
      </div>

      {/* Modal de Exportação/Importação */}
      {isExportModalOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100 flex justify-between items-center">
              <h3 className="text-lg font-medium text-gray-900">Gerenciar Dados</h3>
              <button
                onClick={() => setIsExportModalOpen(false)}
                className="text-gray-400 hover:text-gray-600"
              >
                <i className="fas fa-times"></i>
              </button>
            </div>
            <div className="p-6 space-y-4">
              <p className="text-sm text-gray-500 mb-4">
                {user
                  ? 'Seus dados estão sincronizados em tempo real no Firebase Firestore na nuvem. Você também pode exportar ou restaurar backups em JSON.'
                  : 'Os dados estão salvos localmente. Conecte-se com sua conta Google para salvar automaticamente na nuvem.'}
              </p>

              <button
                onClick={exportarDados}
                className="w-full flex items-center justify-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
              >
                <i className="fas fa-download mr-2 text-indigo-500"></i> Exportar Dados (Backup)
              </button>

              <div className="relative border border-gray-300 shadow-sm rounded-md hover:bg-gray-50 transition-colors">
                <input
                  type="file"
                  accept=".json"
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  onChange={importarDados}
                />
                <div className="px-4 py-2 flex items-center justify-center text-sm font-medium text-gray-700">
                  <i className="fas fa-upload mr-2 text-blue-500"></i> Importar Backup
                </div>
              </div>

              <div className="pt-4 border-t border-gray-100 mt-4">
                <button
                  onClick={confirmarLimpezaDados}
                  className="w-full flex items-center justify-center px-4 py-2 border border-red-300 text-sm font-medium rounded-md text-red-700 bg-red-50 hover:bg-red-100 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
                >
                  <i className="fas fa-trash-alt mr-2"></i> Apagar Todos os Dados
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal de Confirmação Padrão */}
      {confirmModal.open && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-[60] flex items-center justify-center p-4">
          <div className="bg-white rounded-lg p-6 max-w-sm w-full shadow-2xl">
            <h3 className="text-lg font-medium text-gray-900 mb-2">{confirmModal.title}</h3>
            <p className="text-sm text-gray-500 mb-6">{confirmModal.message}</p>
            <div className="flex justify-end space-x-3">
              <button
                onClick={() => setConfirmModal({ open: false, title: '', message: '' })}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
              >
                Cancelar
              </button>
              <button
                onClick={() => {
                  const act = confirmModal.action;
                  setConfirmModal({ open: false, title: '', message: '' });
                  if (act) act();
                }}
                className="px-4 py-2 text-sm font-medium text-white bg-red-600 border border-transparent rounded-md hover:bg-red-700"
              >
                Confirmar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
