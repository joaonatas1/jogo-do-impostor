'use strict';

// Palavras secretas + dica genérica que o impostor recebe.
const CATEGORIES = [
  {
    name: 'Comidas',
    hint: 'É algo que se come ou se bebe.',
    words: [
      'Pizza', 'Sushi', 'Feijoada', 'Brigadeiro', 'Hambúrguer', 'Lasanha',
      'Coxinha', 'Açaí', 'Pão de queijo', 'Churrasco', 'Sorvete', 'Tapioca',
    ],
  },
  {
    name: 'Animais',
    hint: 'É um bicho que faz parte da fauna.',
    words: [
      'Leão', 'Elefante', 'Golfinho', 'Pinguim', 'Girafa', 'Tubarão',
      'Coruja', 'Cavalo', 'Jacaré', 'Abelha', 'Tartaruga', 'Lobo',
    ],
  },
  {
    name: 'Lugares',
    hint: 'É um lugar que existe no dia a dia.',
    words: [
      'Praia', 'Escola', 'Hospital', 'Aeroporto', 'Supermercado', 'Cinema',
      'Biblioteca', 'Academia', 'Parque', 'Restaurante', 'Museu', 'Estádio',
    ],
  },
  {
    name: 'Objetos',
    hint: 'É um objeto de uso comum.',
    words: [
      'Guarda-chuva', 'Celular', 'Espelho', 'Chave', 'Mochila', 'Relógio',
      'Cadeira', 'Travesseiro', 'Escova de dentes', 'Fone de ouvido', 'Ventilador', 'Chuveiro',
    ],
  },
  {
    name: 'Profissões',
    hint: 'É uma profissão.',
    words: [
      'Médico', 'Professor', 'Bombeiro', 'Piloto', 'Cozinheiro', 'Advogado',
      'Dentista', 'Policial', 'Programador', 'Carteiro', 'Fotógrafo', 'Astronauta',
    ],
  },
  {
    name: 'Esportes',
    hint: 'É uma atividade esportiva.',
    words: [
      'Futebol', 'Vôlei', 'Basquete', 'Natação', 'Tênis', 'Ciclismo',
      'Boxe', 'Surfe', 'Skate', 'Atletismo', 'Judô', 'Golfe',
    ],
  },
  {
    name: 'Natureza',
    hint: 'Faz parte da natureza.',
    words: [
      'Montanha', 'Rio', 'Floresta', 'Deserto', 'Vulcão', 'Cachoeira',
      'Oceano', 'Ilha', 'Caverna', 'Arco-íris', 'Tempestade', 'Lago',
    ],
  },
  {
    name: 'Transportes',
    hint: 'Serve para transportar pessoas ou coisas.',
    words: [
      'Avião', 'Bicicleta', 'Trem', 'Ônibus', 'Barco', 'Helicóptero',
      'Moto', 'Metrô', 'Foguete', 'Patinete', 'Caminhão', 'Canoa',
    ],
  },
  {
    name: 'Instrumentos musicais',
    hint: 'Serve para fazer música.',
    words: [
      'Violão', 'Piano', 'Bateria', 'Flauta', 'Guitarra', 'Saxofone',
      'Violino', 'Trompete', 'Sanfona', 'Ukulele', 'Harpa', 'Pandeiro',
    ],
  },
  {
    name: 'Tecnologia',
    hint: 'Tem relação com tecnologia.',
    words: [
      'Computador', 'Internet', 'Robô', 'Satélite', 'Videogame', 'Impressora',
      'Wi-Fi', 'Bateria', 'Drone', 'Teclado', 'Mouse', 'Câmera',
    ],
  },
];

module.exports = { CATEGORIES };
